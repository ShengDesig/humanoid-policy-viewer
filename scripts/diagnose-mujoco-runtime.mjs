import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const SCENES_ROOT = path.join(REPO_ROOT, 'public', 'examples', 'scenes');
const FILE_INDEX = path.join(SCENES_ROOT, 'files.json');
const ENTRY_XML = '/working/g1/g1.xml';

function formatError(error) {
  if (!error) return 'unknown error';
  return error.stack || error.toString?.() || String(error);
}

function ensureMemfsDirectory(mujoco, directory) {
  const normalized = directory.replaceAll('\\', '/');
  const parts = normalized.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current += `/${part}`;
    if (!mujoco.FS.analyzePath(current).exists) {
      mujoco.FS.mkdir(current);
    }
  }
}

async function stageSceneFiles(mujoco) {
  ensureMemfsDirectory(mujoco, '/working');
  const files = JSON.parse(await fs.readFile(FILE_INDEX, 'utf8'));
  for (const relativePath of files) {
    const normalized = String(relativePath).replaceAll('\\', '/');
    const virtualPath = `/working/${normalized}`;
    ensureMemfsDirectory(mujoco, path.posix.dirname(virtualPath));
    const localPath = path.join(SCENES_ROOT, ...normalized.split('/'));
    const bytes = await fs.readFile(localPath);
    mujoco.FS.writeFile(virtualPath, new Uint8Array(bytes));
  }
  return files.length;
}

async function loadRuntime(packageName) {
  const imported = await import(packageName);
  const loadMujoco = imported.default;
  if (typeof loadMujoco !== 'function') {
    throw new TypeError(`${packageName} does not export a default loader function`);
  }
  return loadMujoco();
}

async function diagnoseOfficial() {
  const result = { runtime: '@mujoco/mujoco', stages: [] };
  let mujoco;
  let model;
  let data;
  try {
    result.stages.push('load-wasm:start');
    mujoco = await loadRuntime('@mujoco/mujoco');
    result.stages.push('load-wasm:ok');

    result.stages.push('stage-assets:start');
    const count = await stageSceneFiles(mujoco);
    result.stages.push(`stage-assets:ok:${count}`);

    result.stages.push('read-entry-xml:start');
    const xmlBytes = mujoco.FS.readFile(ENTRY_XML);
    const xml = new TextDecoder('utf-8').decode(xmlBytes);
    result.stages.push(`read-entry-xml:ok:${xml.length}`);

    result.stages.push('compile-model:start');
    const previousDirectory = mujoco.FS.cwd();
    try {
      mujoco.FS.chdir('/working/g1');
      model = mujoco.MjModel.from_xml_string(xml);
    } finally {
      mujoco.FS.chdir(previousDirectory);
    }
    result.stages.push('compile-model:ok');

    result.stages.push('create-data:start');
    data = new mujoco.MjData(model);
    result.stages.push('create-data:ok');

    result.stages.push('forward:start');
    mujoco.mj_forward(model, data);
    result.stages.push('forward:ok');

    result.ok = true;
    result.model = {
      nq: String(model.nq),
      nv: String(model.nv),
      nbody: String(model.nbody),
      njnt: String(model.njnt),
      ngeom: String(model.ngeom),
      qposLength: data.qpos?.length ?? null,
      xposLength: data.xpos?.length ?? null,
    };
  } catch (error) {
    result.ok = false;
    result.error = formatError(error);
  } finally {
    try { data?.delete?.(); } catch {}
    try { model?.delete?.(); } catch {}
  }
  return result;
}

async function diagnoseLegacy() {
  const result = { runtime: 'mujoco-js', stages: [] };
  let mujoco;
  let model;
  let data;
  try {
    result.stages.push('load-wasm:start');
    mujoco = await loadRuntime('mujoco-js');
    result.stages.push('load-wasm:ok');

    result.stages.push('stage-assets:start');
    const count = await stageSceneFiles(mujoco);
    result.stages.push(`stage-assets:ok:${count}`);

    result.stages.push('compile-model:start');
    model = mujoco.MjModel.loadFromXML(ENTRY_XML);
    result.stages.push('compile-model:ok');

    result.stages.push('create-data:start');
    data = new mujoco.MjData(model);
    result.stages.push('create-data:ok');

    if (typeof mujoco.mj_forward === 'function') {
      result.stages.push('forward:start');
      mujoco.mj_forward(model, data);
      result.stages.push('forward:ok');
    } else {
      result.stages.push('forward:unavailable');
    }

    result.ok = true;
    result.model = {
      nq: String(model.nq),
      nv: String(model.nv),
      nbody: String(model.nbody),
      njnt: String(model.njnt),
      ngeom: String(model.ngeom),
      qposLength: data.qpos?.length ?? null,
      xposLength: data.xpos?.length ?? null,
    };
  } catch (error) {
    result.ok = false;
    result.error = formatError(error);
  } finally {
    try { data?.delete?.(); } catch {}
    try { model?.delete?.(); } catch {}
  }
  return result;
}

console.log('HUMANOID_POLICY_VIEWER_MUJOCO_DIAGNOSTIC_V1');
console.log(`NODE=${process.version}`);
console.log(`PLATFORM=${process.platform}-${process.arch}`);
console.log(`REPO_ROOT=${REPO_ROOT}`);

for (const run of [diagnoseOfficial, diagnoseLegacy]) {
  const result = await run();
  console.log('\n---');
  console.log(JSON.stringify(result, null, 2));
}
