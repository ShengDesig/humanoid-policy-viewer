<template>
  <v-app>
    <v-main>
      <ActivePage />

      <div class="mode-switch">
        <v-btn
          :variant="mode === 'policy' ? 'flat' : 'tonal'"
          color="primary"
          size="small"
          href="./?mode=policy"
        >
          Policy Demo
        </v-btn>
        <v-btn
          :variant="mode === 'sysid' ? 'flat' : 'tonal'"
          color="primary"
          size="small"
          href="./?mode=sysid"
        >
          SysID Replay
        </v-btn>
      </div>
    </v-main>
  </v-app>
</template>

<script>
import { defineAsyncComponent } from 'vue'

const requestedMode = new URLSearchParams(window.location.search).get('mode') === 'sysid'
  ? 'sysid'
  : 'policy'

// Keep the two MuJoCo entry points in separate async chunks.  The policy page
// historically imports mujoco-js directly, while SysID replay owns a singleton
// module instance.  Statically importing both pages can make Vite evaluate two
// Embind module paths on one page, which invalidates MjModel/MjData wrappers.
const ActivePage = requestedMode === 'sysid'
  ? defineAsyncComponent(() => import('@/views/SysIDReplay.vue'))
  : defineAsyncComponent(() => import('@/views/Demo.vue'))

export default {
  name: 'App',
  components: {
    ActivePage
  },
  data: () => ({
    mode: requestedMode
  })
}
</script>

<style>
body,
.v-application {
  font-family: 'Google Sans', 'Noto Sans SC', Arial, sans-serif !important;
}

html,
body {
  overflow-x: clip;
  width: 100%;
  position: relative;
}

.v-application {
  overflow-x: clip;
}

.v-container {
  max-width: 100%;
}

.mode-switch {
  position: fixed;
  left: 16px;
  bottom: 16px;
  display: flex;
  gap: 8px;
  z-index: 1500;
}
</style>
