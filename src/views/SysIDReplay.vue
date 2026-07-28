<template>
  <div id="mujoco-container"></div>

  <div class="sysid-controls">
    <v-card class="controls-card">
      <v-card-title>G1 SysID Replay</v-card-title>
      <v-card-subtitle>Direct recorded-state playback; ONNX inference is bypassed.</v-card-subtitle>

      <v-card-text>
        <v-file-input
          v-model="motionFiles"
          label="Load exported motion JSON"
          accept=".json,application/json"
          prepend-icon="mdi-folder-open"
          density="compact"
          show-size
          :disabled="state !== 1"
          @update:modelValue="onMotionFile"
        ></v-file-input>

        <v-alert
          v-if="loadMessage"
          :type="loadMessageType"
          variant="tonal"
          density="compact"
          class="mb-3"
        >
          {{ loadMessage }}
        </v-alert>

        <template v-if="playback.available">
          <div class="status-row">
            <span>Frame</span>
            <span>{{ playback.frameIndex + 1 }} / {{ playback.frameCount }}</span>
          </div>
          <div class="status-row">
            <span>Time</span>
            <span>{{ timeLabel }}</span>
          </div>
          <div class="status-row">
            <span>Source</span>
            <span>{{ sourceLabel }}</span>
          </div>

          <v-slider
            :model-value="playback.frameIndex"
            :max="Math.max(playback.frameCount - 1, 0)"
            min="0"
            step="1"
            density="compact"
            hide-details
            class="mt-3"
            @update:modelValue="seekFrame"
          ></v-slider>

          <div class="button-row mt-3">
            <v-btn color="primary" @click="togglePlayback">
              <v-icon :icon="isPlaying ? 'mdi-pause' : 'mdi-play'" class="mr-1"></v-icon>
              {{ isPlaying ? 'Pause' : 'Play' }}
            </v-btn>
            <v-btn variant="tonal" @click="resetPlayback">
              <v-icon icon="mdi-restart" class="mr-1"></v-icon>
              Reset
            </v-btn>
          </div>

          <v-select
            v-model="playbackSpeed"
            :items="speedItems"
            label="Playback speed"
            density="compact"
            hide-details
            class="mt-3"
          ></v-select>
        </template>

        <v-alert v-else type="info" variant="tonal" density="compact">
          Export an NPZ file with <code>export_viewer_motion.py</code>, then load the generated
          <code>motions/default.json</code> here.
        </v-alert>
      </v-card-text>
    </v-card>
  </div>

  <v-dialog :model-value="state === 0" persistent max-width="560px">
    <v-card title="Loading G1 MuJoCo scene">
      <v-card-text>
        <v-progress-linear indeterminate color="primary"></v-progress-linear>
        <div class="mt-3">{{ loadingLabel }}</div>
      </v-card-text>
    </v-card>
  </v-dialog>

  <v-dialog :model-value="state < 0" persistent max-width="600px">
    <v-card title="SysID replay loading error">
      <v-card-text>
        <div>{{ errorMessage }}</div>
        <div class="mt-3 text-caption">
          Initialization stage: {{ initStage || 'unknown' }}
        </div>
      </v-card-text>
      <v-card-actions>
        <v-btn color="primary" block @click="reloadPage">Reload page</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script>
import { MuJoCoDemo } from '@/simulation/main.js';
import { downloadExampleScenesFolder } from '@/simulation/mujocoUtils.js';
import { loadMujocoSingleton } from '@/simulation/mujocoSingleton.js';
import { SysIDReplayController } from '@/simulation/sysidReplay.js';

export default {
  name: 'SysIDReplayPage',
  data: () => ({
    state: 0,
    initStage: 'starting',
    errorMessage: '',
    demo: null,
    controller: null,
    motionFiles: [],
    loadMessage: '',
    loadMessageType: 'success',
    isPlaying: false,
    animationId: null,
    playStartMs: 0,
    playStartFrame: 0,
    playbackSpeed: 1,
    speedItems: [
      { title: '0.25×', value: 0.25 },
      { title: '0.5×', value: 0.5 },
      { title: '1×', value: 1 },
      { title: '2×', value: 2 },
      { title: '4×', value: 4 }
    ],
    playback: {
      available: false,
      frameIndex: 0,
      frameCount: 0,
      timeS: 0,
      durationS: 0,
      frameRate: 0,
      metadata: {}
    }
  }),
  computed: {
    timeLabel() {
      return `${this.playback.timeS.toFixed(3)} / ${this.playback.durationS.toFixed(3)} s`;
    },
    sourceLabel() {
      const metadata = this.playback.metadata ?? {};
      return metadata.source_series ?? metadata.source_path ?? 'exported motion JSON';
    },
    loadingLabel() {
      const labels = {
        starting: 'Preparing SysID replay.',
        wasm: 'Loading the singleton MuJoCo WebAssembly module.',
        demo: 'Creating the G1 viewer.',
        assets: 'Loading G1 MJCF and mesh assets.',
        scene: 'Compiling the G1 MuJoCo scene.',
        controller: 'Preparing direct recorded-state playback.'
      };
      return labels[this.initStage] ?? 'Loading MuJoCo WebAssembly and G1 assets. No ONNX policy is loaded.';
    }
  },
  methods: {
    async init() {
      if (typeof WebAssembly !== 'object' || typeof WebAssembly.instantiate !== 'function') {
        this.state = -1;
        this.errorMessage = 'This browser does not support WebAssembly.';
        return;
      }

      try {
        this.initStage = 'wasm';
        const mujoco = await loadMujocoSingleton();

        this.initStage = 'demo';
        this.demo = new MuJoCoDemo(mujoco);

        this.initStage = 'assets';
        await downloadExampleScenesFolder(mujoco);

        this.initStage = 'scene';
        await this.demo.reloadScene('g1/g1.xml');
        this.demo.updateFollowBodyId();
        this.demo.params.paused = true;
        this.demo.alive = false;

        this.initStage = 'controller';
        this.controller = new SysIDReplayController(this.demo);
        this.demo.simulation.forward();
        this.controller.syncVisualState();

        this.initStage = 'ready';
        this.state = 1;
        await this.loadMotionFromQuery();
      } catch (error) {
        console.error(`Failed to initialize SysID replay at ${this.initStage}:`, error);
        this.state = -1;
        const message = error?.toString?.() ?? String(error);
        this.errorMessage = `${message}`;
      }
    },
    reloadPage() {
      window.location.reload();
    },
    loadPayload(payload, sourceDescription = 'motion JSON') {
      if (!this.controller) {
        throw new Error('SysID replay controller is not ready');
      }
      this.pausePlayback();
      const clip = this.controller.load(payload);
      this.playback = { ...this.controller.playbackState() };
      this.loadMessageType = 'success';
      this.loadMessage = `Loaded ${clip.frameCount} frames, ${clip.durationS.toFixed(3)} seconds at ${clip.frameRate.toFixed(2)} Hz.`;
      console.info(`Loaded SysID motion from ${sourceDescription}`);
      return clip;
    },
    async loadMotionFromQuery() {
      const params = new URLSearchParams(window.location.search);
      const requestedPath = params.get('motion');
      if (!requestedPath) {
        return;
      }

      try {
        const motionUrl = new URL(requestedPath, window.location.href);
        if (motionUrl.origin !== window.location.origin) {
          throw new Error('Bundled motion URL must use the same origin as the viewer');
        }
        const response = await fetch(motionUrl, { cache: 'no-store' });
        if (!response.ok) {
          throw new Error(`Failed to load bundled motion: HTTP ${response.status}`);
        }
        const payload = await response.json();
        this.loadPayload(payload, motionUrl.pathname);
        if (params.get('autoplay') === '1') {
          requestAnimationFrame(() => this.startPlayback());
        }
      } catch (error) {
        console.error('Failed to auto-load bundled SysID motion:', error);
        this.loadMessageType = 'error';
        this.loadMessage = error?.toString?.() ?? String(error);
      }
    },
    async onMotionFile(files) {
      const fileList = Array.isArray(files)
        ? files
        : files instanceof FileList
          ? Array.from(files)
          : files
            ? [files]
            : [];
      if (fileList.length === 0 || !this.controller) {
        return;
      }

      try {
        const file = fileList[0];
        const payload = JSON.parse(await file.text());
        this.loadPayload(payload, file.name);
      } catch (error) {
        console.error('Failed to load SysID motion:', error);
        this.loadMessageType = 'error';
        this.loadMessage = error?.toString?.() ?? String(error);
      } finally {
        this.motionFiles = [];
      }
    },
    togglePlayback() {
      if (this.isPlaying) {
        this.pausePlayback();
      } else {
        this.startPlayback();
      }
    },
    startPlayback() {
      if (!this.playback.available || !this.controller) {
        return;
      }
      if (this.playback.frameIndex >= this.playback.frameCount - 1) {
        this.controller.applyFrame(0);
        this.playback = { ...this.controller.playbackState() };
      }
      this.isPlaying = true;
      this.playStartMs = performance.now();
      this.playStartFrame = this.playback.frameIndex;
      this.animationId = requestAnimationFrame(this.advancePlayback);
    },
    pausePlayback() {
      this.isPlaying = false;
      if (this.animationId !== null) {
        cancelAnimationFrame(this.animationId);
        this.animationId = null;
      }
    },
    advancePlayback(now) {
      if (!this.isPlaying || !this.controller?.clip) {
        return;
      }
      const elapsedS = Math.max(0, (now - this.playStartMs) / 1000);
      const framesAdvanced = elapsedS * this.controller.clip.frameRate * Number(this.playbackSpeed);
      const requestedFrame = Math.floor(this.playStartFrame + framesAdvanced);
      const finalFrame = this.controller.clip.frameCount - 1;
      this.controller.applyFrame(Math.min(requestedFrame, finalFrame));
      this.playback = { ...this.controller.playbackState() };

      if (requestedFrame >= finalFrame) {
        this.pausePlayback();
        return;
      }
      this.animationId = requestAnimationFrame(this.advancePlayback);
    },
    seekFrame(value) {
      if (!this.controller || !this.playback.available) {
        return;
      }
      this.pausePlayback();
      this.controller.applyFrame(Number(value));
      this.playback = { ...this.controller.playbackState() };
    },
    resetPlayback() {
      if (!this.controller || !this.playback.available) {
        return;
      }
      this.pausePlayback();
      this.controller.applyFrame(0);
      this.playback = { ...this.controller.playbackState() };
    }
  },
  mounted() {
    this.init();
  },
  beforeUnmount() {
    this.pausePlayback();
    if (this.demo) {
      this.demo.alive = false;
      this.demo.renderer?.setAnimationLoop(null);
      this.demo.renderer?.dispose?.();
      this.demo.simulation?.free?.();
    }
  }
};
</script>

<style scoped>
.sysid-controls {
  position: fixed;
  top: 20px;
  right: 20px;
  width: 360px;
  z-index: 1000;
}

.controls-card {
  max-height: calc(100vh - 40px);
  overflow-y: auto;
}

.status-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-top: 6px;
  font-size: 0.85rem;
}

.status-row span:last-child {
  text-align: right;
  overflow-wrap: anywhere;
}

.button-row {
  display: flex;
  gap: 8px;
}

code {
  font-family: Consolas, 'Courier New', monospace;
}
</style>
