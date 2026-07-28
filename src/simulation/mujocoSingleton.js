import loadMujoco from '@mujoco/mujoco';

const PROMISE_KEY = '__HUMANOID_POLICY_VIEWER_MUJOCO_PROMISE__';
const INSTANCE_KEY = '__HUMANOID_POLICY_VIEWER_MUJOCO_INSTANCE__';

const LEGACY_NUMBER_FIELDS = [
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
];

// The canonical bindings currently expose this model field as
// emscripten::memory_view<bool>.  Accessing its generated getter in JavaScript
// throws `_emval_take_value has unknown type ... memory_view<bool>`.  The
// renderer already has a safe fallback when the field is absent/falsy, so
// shadow the unsupported getter without reading it.
const UNSUPPORTED_BOOL_VIEW_FIELDS = ['light_castshadow'];

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

function maskUnsupportedMemoryViews(model) {
  for (const field of UNSUPPORTED_BOOL_VIEW_FIELDS) {
    try {
      Object.defineProperty(model, field, {
        configurable: true,
        enumerable: false,
        writable: false,
        value: null
      });
    } catch (error) {
      throw new Error(
        `Unable to mask unsupported MjModel.${field} memory view: ${error}`
      );
    }
  }
  return model;
}

/**
 * The canonical MuJoCo bindings expose address-sized C fields as BigInt values
 * on some browser/OS combinations.  The upstream viewer predates those
 * bindings and performs normal Number arithmetic on mesh, texture and name
 * addresses.  Shadow only the fields consumed by the JavaScript renderer with
 * Number-compatible values while retaining the original Embind MjModel object
 * for MjData construction and MuJoCo C API calls.
 */
function installLegacyModelNumberViews(model) {
  maskUnsupportedMemoryViews(model);

  for (const field of LEGACY_NUMBER_FIELDS) {
    let original;
    try {
      original = model[field];
    } catch {
      continue;
    }

    const compatible = numberCompatibleValue(original);
    if (compatible === original) {
      continue;
    }

    try {
      Object.defineProperty(model, field, {
        configurable: true,
        enumerable: false,
        writable: false,
        value: compatible
      });
    } catch (error) {
      throw new Error(
        `Unable to install Number compatibility for MjModel.${field}: ${error}`
      );
    }
  }
  return model;
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
        const model = mujoco.MjModel.from_xml_string(xml);
        if (!model) {
          throw new Error(`MuJoCo failed to compile MJCF: ${path}`);
        }
        return installLegacyModelNumberViews(model);
      } finally {
        mujoco.FS.chdir(previousDirectory);
      }
    }
  });
}

/**
 * Return one MuJoCo Emscripten module per browser page.
 *
 * Embind wrapper objects are owned by the module instance that created them.
 * Passing wrappers across module instances produces same-name BindingErrors.
 */
export async function loadMujocoSingleton() {
  if (globalThis[INSTANCE_KEY]) {
    installModelLoaderCompatibility(globalThis[INSTANCE_KEY]);
    return globalThis[INSTANCE_KEY];
  }

  if (!globalThis[PROMISE_KEY]) {
    globalThis[PROMISE_KEY] = loadMujoco()
      .then((instance) => {
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
