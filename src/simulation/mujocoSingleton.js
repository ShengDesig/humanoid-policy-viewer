import loadMujoco from 'mujoco-js';

const PROMISE_KEY = '__HUMANOID_POLICY_VIEWER_MUJOCO_PROMISE__';
const INSTANCE_KEY = '__HUMANOID_POLICY_VIEWER_MUJOCO_INSTANCE__';

/**
 * Return one MuJoCo Emscripten module per browser page.
 *
 * Embind wrapper objects (MjModel, MjData, and friends) are owned by the
 * module instance that created them. Passing an MjModel wrapper into a second
 * module instance produces the confusing error:
 *
 *   Expected null or instance of MjModel, got an instance of MjModel
 *
 * Keeping the promise on globalThis also survives Vite hot-module reloads.
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
