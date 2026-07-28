# G1 SysID replay mode

This fork adds a direct playback path for motion data exported from `ShengDesig/g1_systemID`.

## Data flow

```text
experiment.npz
  -> scripts/export_viewer_motion.py (g1_systemID)
  -> motions/default.json
  -> browser SysID Replay mode
  -> direct MuJoCo qpos playback
```

The replay path intentionally bypasses ONNX policy inference. Each frame writes the recorded root pose and 29 G1 joint positions directly into the MuJoCo state, calls `forward()`, and updates the Three.js scene.

## Export the NPZ recording

From the `g1_systemID` integration branch:

```powershell
python .\scripts\export_viewer_motion.py `
  .\logs\sim_left_palm_9bbe498.npz `
  --series q_meas `
  --fps 60 `
  --motion-name default `
  --out-dir .\build\humanoid-policy-viewer
```

The file to upload is:

```text
build/humanoid-policy-viewer/motions/default.json
```

## Run the viewer

```bash
npm install
npm run dev
```

Open the SysID page:

```text
http://localhost:5173/?mode=sysid
```

Load `motions/default.json`, then use Play, Pause, Reset, the frame slider, and playback speed selector.

## Supported clip contract

Required:

- `joint_pos`: `N x 29`

Optional:

- `root_pos`: `N x 3`; defaults to `[0, 0, 0.78]`
- `root_quat`: `N x 4` in `(w, x, y, z)` order; defaults to identity
- `_meta.joint_names`: 29 dataset joint names
- `_meta.duration_s`: duration used to recover the playback rate
- `_meta.source_series`: for example `q_meas` or `q_cmd`

Joint names are resolved against the loaded MJCF using `<name>_joint` first and the original name second. Missing joints or malformed frame shapes are rejected before playback.
