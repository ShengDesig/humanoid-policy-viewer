import * as THREE from 'three';
import { getPosition, getQuaternion } from './mujocoUtils.js';

export const G1_29DOF_JOINT_NAMES = [
  'left_hip_pitch',
  'left_hip_roll',
  'left_hip_yaw',
  'left_knee',
  'left_ankle_pitch',
  'left_ankle_roll',
  'right_hip_pitch',
  'right_hip_roll',
  'right_hip_yaw',
  'right_knee',
  'right_ankle_pitch',
  'right_ankle_roll',
  'waist_yaw',
  'waist_roll',
  'waist_pitch',
  'left_shoulder_pitch',
  'left_shoulder_roll',
  'left_shoulder_yaw',
  'left_elbow',
  'left_wrist_roll',
  'left_wrist_pitch',
  'left_wrist_yaw',
  'right_shoulder_pitch',
  'right_shoulder_roll',
  'right_shoulder_yaw',
  'right_elbow',
  'right_wrist_roll',
  'right_wrist_pitch',
  'right_wrist_yaw'
];

function readRows(value, width, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array of frames`);
  }
  return value.map((row, index) => {
    if (!Array.isArray(row) || row.length !== width) {
      throw new Error(`${label}[${index}] must contain exactly ${width} values`);
    }
    const normalized = row.map((entry) => Number(entry));
    if (!normalized.every(Number.isFinite)) {
      throw new Error(`${label}[${index}] contains a non-finite value`);
    }
    return Float32Array.from(normalized);
  });
}

function fallbackRows(frameCount, row) {
  return Array.from({ length: frameCount }, () => Float32Array.from(row));
}

function normalizeQuaternionRows(rows) {
  return rows.map((row, index) => {
    const norm = Math.hypot(row[0], row[1], row[2], row[3]);
    if (!Number.isFinite(norm) || norm <= 1e-8) {
      throw new Error(`root_quat[${index}] has zero or invalid magnitude`);
    }
    return Float32Array.from([
      row[0] / norm,
      row[1] / norm,
      row[2] / norm,
      row[3] / norm
    ]);
  });
}

export function normalizeSysIDClip(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('SysID replay clip must be a JSON object');
  }

  const jointPos = readRows(payload.joint_pos ?? payload.jointPos, 29, 'joint_pos');
  const frameCount = jointPos.length;
  const rootPosRaw = payload.root_pos ?? payload.rootPos;
  const rootQuatRaw = payload.root_quat ?? payload.rootQuat;
  const rootPos = rootPosRaw
    ? readRows(rootPosRaw, 3, 'root_pos')
    : fallbackRows(frameCount, [0.0, 0.0, 0.78]);
  const rootQuat = normalizeQuaternionRows(
    rootQuatRaw
      ? readRows(rootQuatRaw, 4, 'root_quat')
      : fallbackRows(frameCount, [1.0, 0.0, 0.0, 0.0])
  );

  if (rootPos.length !== frameCount || rootQuat.length !== frameCount) {
    throw new Error('joint_pos, root_pos and root_quat must contain the same number of frames');
  }

  const metadata = payload._meta && typeof payload._meta === 'object' ? payload._meta : {};
  const jointNamesRaw = metadata.joint_names ?? payload.joint_names ?? G1_29DOF_JOINT_NAMES;
  if (!Array.isArray(jointNamesRaw) || jointNamesRaw.length !== 29) {
    throw new Error('joint_names must contain exactly 29 entries');
  }
  const jointNames = jointNamesRaw.map((name) => String(name).trim());

  const durationValue = Number(metadata.duration_s);
  const durationS = Number.isFinite(durationValue) && durationValue > 0
    ? durationValue
    : Math.max(0, (frameCount - 1) / 60);
  const frameRate = frameCount > 1 && durationS > 0
    ? (frameCount - 1) / durationS
    : 60;

  return {
    jointPos,
    rootPos,
    rootQuat,
    jointNames,
    frameCount,
    durationS,
    frameRate,
    metadata
  };
}

export class SysIDReplayController {
  constructor(demo) {
    this.demo = demo;
    this.clip = null;
    this.frameIndex = 0;
    this.qposAddresses = [];
  }

  load(payload) {
    this.clip = normalizeSysIDClip(payload);
    this.qposAddresses = this._resolveJointQposAddresses(this.clip.jointNames);
    this.frameIndex = 0;
    this.applyFrame(0);
    return this.clip;
  }

  _resolveJointQposAddresses(jointNames) {
    const model = this.demo.model;
    const modelJointNames = this.demo.jointNamesMJC ?? [];
    if (!model || modelJointNames.length === 0) {
      throw new Error('MuJoCo scene joint metadata is not ready');
    }

    return jointNames.map((name) => {
      const candidates = name.endsWith('_joint') ? [name] : [`${name}_joint`, name];
      for (const candidate of candidates) {
        const jointId = modelJointNames.indexOf(candidate);
        if (jointId >= 0) {
          return Number(model.jnt_qposadr[jointId]);
        }
      }
      throw new Error(`Joint not found in the loaded MJCF: ${name}`);
    });
  }

  applyFrame(index) {
    if (!this.clip) {
      return null;
    }
    const clamped = Math.max(0, Math.min(Math.round(index), this.clip.frameCount - 1));
    const simulation = this.demo.simulation;
    if (!simulation) {
      throw new Error('MuJoCo simulation is not ready');
    }

    const rootPos = this.clip.rootPos[clamped];
    const rootQuat = this.clip.rootQuat[clamped];
    if (simulation.qpos.length >= 7) {
      simulation.qpos[0] = rootPos[0];
      simulation.qpos[1] = rootPos[1];
      simulation.qpos[2] = rootPos[2];
      simulation.qpos[3] = rootQuat[0];
      simulation.qpos[4] = rootQuat[1];
      simulation.qpos[5] = rootQuat[2];
      simulation.qpos[6] = rootQuat[3];
    }

    const jointPos = this.clip.jointPos[clamped];
    for (let i = 0; i < this.qposAddresses.length; i++) {
      simulation.qpos[this.qposAddresses[i]] = jointPos[i];
    }
    for (let i = 0; i < simulation.qvel.length; i++) {
      simulation.qvel[i] = 0.0;
    }

    simulation.forward();
    this.frameIndex = clamped;
    this.syncVisualState();
    return this.playbackState();
  }

  playbackState() {
    if (!this.clip) {
      return {
        available: false,
        frameIndex: 0,
        frameCount: 0,
        timeS: 0,
        durationS: 0,
        frameRate: 0
      };
    }
    const timeS = this.clip.frameRate > 0 ? this.frameIndex / this.clip.frameRate : 0;
    return {
      available: true,
      frameIndex: this.frameIndex,
      frameCount: this.clip.frameCount,
      timeS: Math.min(timeS, this.clip.durationS),
      durationS: this.clip.durationS,
      frameRate: this.clip.frameRate,
      metadata: this.clip.metadata
    };
  }

  syncVisualState() {
    const { demo } = this;
    if (!demo.model || !demo.simulation) {
      return;
    }

    for (let bodyId = 0; bodyId < demo.model.nbody; bodyId++) {
      if (!demo.bodies[bodyId]) {
        continue;
      }
      if (!demo.lastSimState.bodies.has(bodyId)) {
        demo.lastSimState.bodies.set(bodyId, {
          position: new THREE.Vector3(),
          quaternion: new THREE.Quaternion()
        });
      }
      const cached = demo.lastSimState.bodies.get(bodyId);
      getPosition(demo.simulation.xpos, bodyId, cached.position);
      getQuaternion(demo.simulation.xquat, bodyId, cached.quaternion);
      demo.bodies[bodyId].position.copy(cached.position);
      demo.bodies[bodyId].quaternion.copy(cached.quaternion);
      demo.bodies[bodyId].updateWorldMatrix();
    }
  }
}
