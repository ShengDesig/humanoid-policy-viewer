import loadMujoco from '@mujoco/mujoco';

const PROMISE_KEY = '__HUMANOID_POLICY_VIEWER_MUJOCO_PROMISE__';
const INSTANCE_KEY = '__HUMANOID_POLICY_VIEWER_MUJOCO_INSTANCE__';

function readUtf8File(fs, path) {
  const value = fs.readFile(path, { encoding: 'utf8' });
  if (typeof value === 'string') {
    return value;
  }
  return new TextDecoder('utf-8').decode(value);
}

/**
 * Bridge the legacy community binding API used by the existing viewer to the
 * canonical @mujoco/mujoco API.
 *
 * mujoco-js exposed `MjModel.loadFromXML(path)`, while the maintained bindings
 * expose `MjModel.from_xml_string(xml)`.  The viewer already stages the MJCF,
 * include files, meshes and textures into Emscripten MEMFS.  Read the entry
 * XML from MEMFS and temporarily change into its directory so relative
 * `<include>` and asset paths continue to resolve during compilation.
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
        return model;
      } finally {
        mujoco.FS.chdir(previousDirectory);
      }
    }
  });
}

/**
 * Return one MuJoCo Emscripten module per browser page.
 *
 * Embind wrapper objects (MjModel, MjData, and friends) are owned by the
 * module instance that created them. Passing wrappers across module instances
 * produces same-name BindingError failures. Keep one maintained
 * @mujoco/mujoco instance for the lifetime of the page.
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
