function ensureDirectory(fs, directory) {
  const normalized = String(directory).replaceAll('\\', '/');
  const parts = normalized.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current += `/${part}`;
    if (!fs.analyzePath(current).exists) {
      fs.mkdir(current);
    }
  }
}

function isBinaryAsset(path) {
  return /\.(png|stl|skn)$/i.test(path);
}

async function fetchAsset(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} seconds`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Load the G1 MJCF and mesh set into MuJoCo MEMFS with bounded concurrency.
 *
 * The original viewer started every asset request at once and exposed no
 * progress.  On Windows machines with Defender or endpoint protection this can
 * look frozen while dozens of STL files are scanned.  This loader limits the
 * number of simultaneous files, validates HTTP responses, applies a per-file
 * timeout and reports deterministic progress to the UI.
 */
export async function downloadSysIDSceneAssets(
  mujoco,
  {
    concurrency = 4,
    timeoutMs = 60000,
    onProgress = null,
  } = {},
) {
  if (!mujoco?.FS) {
    throw new Error('MuJoCo filesystem is unavailable');
  }

  onProgress?.({ completed: 0, total: 0, currentFile: 'examples/scenes/files.json' });
  const manifestResponse = await fetchAsset('./examples/scenes/files.json', timeoutMs);
  const allFiles = await manifestResponse.json();
  if (!Array.isArray(allFiles) || allFiles.length === 0) {
    throw new Error('G1 scene asset manifest is empty or invalid');
  }

  ensureDirectory(mujoco.FS, '/working');
  for (const relativePath of allFiles) {
    const normalized = String(relativePath).replaceAll('\\', '/');
    const separator = normalized.lastIndexOf('/');
    if (separator > 0) {
      ensureDirectory(mujoco.FS, `/working/${normalized.slice(0, separator)}`);
    }
  }

  const workerCount = Math.max(1, Math.min(Number(concurrency) || 1, allFiles.length));
  let nextIndex = 0;
  let completed = 0;

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= allFiles.length) {
        return;
      }

      const relativePath = String(allFiles[index]).replaceAll('\\', '/');
      onProgress?.({ completed, total: allFiles.length, currentFile: relativePath });

      try {
        const response = await fetchAsset(`./examples/scenes/${relativePath}`, timeoutMs);
        const content = isBinaryAsset(relativePath)
          ? new Uint8Array(await response.arrayBuffer())
          : await response.text();
        mujoco.FS.writeFile(`/working/${relativePath}`, content);
      } catch (error) {
        throw new Error(`Failed to load G1 asset "${relativePath}": ${error?.message ?? error}`);
      }

      completed += 1;
      onProgress?.({ completed, total: allFiles.length, currentFile: relativePath });
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return { completed, total: allFiles.length };
}
