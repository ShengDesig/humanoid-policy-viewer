import loadMujoco from '@mujoco/mujoco';

const PROMISE_KEY = '__HUMANOID_POLICY_VIEWER_MUJOCO_PROMISE__';
const INSTANCE_KEY = '__HUMANOID_POLICY_VIEWER_MUJOCO_INSTANCE__';

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
    return globalThis[INSTANCE_KEY];
  }

  if (!globalThis[PROMISE_KEY]) {
    globalThis[PROMISE_KEY] = loadMujoco()
      .then((instance) => {
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
