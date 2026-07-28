import loadMujoco from '@mujoco/mujoco';

const PROMISE_KEY = '__HUMANOID_POLICY_VIEWER_MUJOCO_PROMISE__';
const INSTANCE_KEY = '__HUMANOID_POLICY_VIEWER_MUJOCO_INSTANCE__';
const ARGUMENT_PATCH_KEY = '__HUMANOID_POLICY_VIEWER_MODEL_ARGUMENT_PATCH__';

const RAW_MODEL_BY_VIEW = new WeakMap();

const LEGACY_NUMBER_FIELDS = new Set([
  // Model sizes used as JavaScript loop bounds.
  'nq', 'nv', 'nbody', 'njnt', 'ngeom', 'nlight', 'nu',

  // Name and object address tables.
  'name_jntadr', 'name_bodyadr',

  // Geometry and mesh indices/addresses used by the Three.js scene builder.
  'geom_group', 'geom_bodyid', 'geom_type', 'geom_dataid', 'geom_matid',
  'mesh_vertadr', 'mesh_vertnum', 'mesh_texcoordadr',
  'mesh_faceadr', 'mesh_facenum',

  // Material/texture tables.
  'mat_texid', 'tex_width', 'tex_height', 'tex_adr', 'tex_nchannel',

  // Joint/actuator mappings.
  'actuator_trntype', 'actuator_trnid', 'jnt_qposadr', 'jnt_dofadr',

  // Tendon rendering address tables.
  'ten_wrapadr', 'ten_wrapnum'
]);

// The canonical bindings expose this field as emscripten::memory_view<bool> on
// some builds. Reading the generated getter throws before JavaScript can use
// the value. The renderer already has a safe fallback when this field is null.
const UNSUPPORTED_BOOL_VIEW_FIELDS = new Set(['light_castshadow']);

function readUtf8File(fs, path) {
  const value = fs.readFile(path, { encoding: 'utf8' });
  if (typeof value === 'string') {
    return value;
  }
  return new TextDecoder('utf-8').decode(value);
}

function isBigIntTypedArray(value) {
  return (
    (typeof BigInt64Array !== 'undefined' && value instanceof BigInt64Array)
    || (typeof BigUint64Array !== 'undefined' && value instanceof BigUint64Array)
  );
}

function numberCompatibleValue(value) {
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (isBigIntTypedArray(value)) {
    return Float64Array.from(value, (entry) => Number(entry));
  }
  return value;
}

function unwrapModel(model) {
  return RAW_MODEL_BY_VIEW.get(model) ?? model;
}

/**
 * Return a JavaScript-only view of an Embind MjModel.
 *
 * The Proxy is never passed into MuJoCo constructors or C API functions. It
 * only adapts fields read by the legacy Three.js renderer. Function members
 * are bound back to the raw model so calls such as model.delete() remain valid.
 */
function createLegacyModelView(model) {
  const convertedFields = new Map();

  const view = new Proxy(model, {
    get(target, property) {
      if (UNSUPPORTED_BOOL_VIEW_FIELDS.has(property)) {
        return null;
      }

      if (LEGACY_NUMBER_FIELDS.has(property)) {
        if (!convertedFields.has(property)) {
          const original = Reflect.get(target, property, target);
          convertedFields.set(property, numberCompatibleValue(original));
        }
        return convertedFields.get(property);
      }

      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });

  RAW_MODEL_BY_VIEW.set(view, model);
  return view;
}

/**
 * Ensure all MuJoCo entry points receive the raw Embind model even when the
 * viewer holds a renderer Proxy. This preserves exact MjModel class identity.
 */
function installModelArgumentCompatibility(mujoco) {
  if (mujoco[ARGUMENT_PATCH_KEY]) {
    return;
  }

  const NativeMjData = mujoco.MjData;
  if (typeof NativeMjData !== 'function') {
    throw new Error('MuJoCo MjData constructor is unavailable');
  }

  function CompatibleMjData(model, ...args) {
    return new NativeMjData(unwrapModel(model), ...args);
  }
  Object.setPrototypeOf(CompatibleMjData, NativeMjData);
  CompatibleMjData.prototype = NativeMjData.prototype;

  Object.defineProperty(mujoco, 'MjData', {
    configurable: true,
    enumerable: true,
    writable: false,
    value: CompatibleMjData
  });

  for (const functionName of ['mj_step', 'mj_resetData', 'mj_forward', 'mj_applyFT']) {
    const nativeFunction = mujoco[functionName];
    if (typeof nativeFunction !== 'function') {
      continue;
    }

    Object.defineProperty(mujoco, functionName, {
      configurable: true,
      enumerable: true,
      writable: false,
      value: (model, ...args) => nativeFunction(unwrapModel(model), ...args)
    });
  }

  Object.defineProperty(mujoco, ARGUMENT_PATCH_KEY, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: true
  });
}

/**
 * Bridge the legacy community binding API used by the existing viewer to the
 * canonical @mujoco/mujoco API.
 *
 * mujoco-js exposed `MjModel.loadFromXML(path)`, while the maintained bindings
 * expose `MjModel.from_xml_string(xml)`. The viewer stages the MJCF, include
 * files, meshes and textures into Emscripten MEMFS. Read the entry XML from
 * MEMFS and temporarily change into its directory so relative assets resolve.
 */
function installModelLoaderCompatibility(mujoco) {
  if (typeof mujoco?.MjModel?.loadFromXML === 'function') {
    return;
  }
  if (typeof mujoco?.MjModel?.from_xml_string !== 'function') {
    throw new Error(
      'Unsupported MuJoCo JavaScript API: expected MjModel.from_xml_string(xml)'
    );
  }
  if (!mujoco.FS?.readFile || !mujoco.FS?.chdir || !mujoco.FS?.cwd) {
    throw new Error('MuJoCo Emscripten filesystem API is unavailable');
  }

  Object.defineProperty(mujoco.MjModel, 'loadFromXML', {
    configurable: true,
    enumerable: false,
    writable: false,
    value: (path) => {
      const normalizedPath = String(path).replaceAll('\\', '/');
      const separator = normalizedPath.lastIndexOf('/');
      const directory = separator > 0 ? normalizedPath.slice(0, separator) : '.';
      const filename = separator >= 0 ? normalizedPath.slice(separator + 1) : normalizedPath;
      const previousDirectory = mujoco.FS.cwd();

      if (!filename) {
        throw new Error(`Invalid MJCF path: ${path}`);
      }

      try {
        mujoco.FS.chdir(directory);
        const xml = readUtf8File(mujoco.FS, filename);
        const rawModel = mujoco.MjModel.from_xml_string(xml);
        if (!rawModel) {
          throw new Error(`MuJoCo failed to compile MJCF: ${path}`);
        }
        return createLegacyModelView(rawModel);
      } finally {
        mujoco.FS.chdir(previousDirectory);
      }
    }
  });
}

/**
 * Return one MuJoCo Emscripten module per browser page.
 */
export async function loadMujocoSingleton() {
  if (globalThis[INSTANCE_KEY]) {
    installModelArgumentCompatibility(globalThis[INSTANCE_KEY]);
    installModelLoaderCompatibility(globalThis[INSTANCE_KEY]);
    return globalThis[INSTANCE_KEY];
  }

  if (!globalThis[PROMISE_KEY]) {
    globalThis[PROMISE_KEY] = loadMujoco()
      .then((instance) => {
        installModelArgumentCompatibility(instance);
        installModelLoaderCompatibility(instance);
        globalThis[INSTANCE_KEY] = instance;
        return instance;
      })
      .catch((error) => {
        delete globalThis[PROMISE_KEY];
        delete globalThis[INSTANCE_KEY];
        throw error;
      });
  }

  return globalThis[PROMISE_KEY];
}

export function clearMujocoSingletonForReload() {
  delete globalThis[PROMISE_KEY];
  delete globalThis[INSTANCE_KEY];
}
