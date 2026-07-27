<template>
  <v-app>
    <v-main>
      <SysIDReplay v-if="mode === 'sysid'" />
      <Demo v-else />

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
import Demo from '@/views/Demo.vue'
import SysIDReplay from '@/views/SysIDReplay.vue'

export default {
  name: 'App',
  components: {
    Demo,
    SysIDReplay
  },
  data: () => ({
    mode: new URLSearchParams(window.location.search).get('mode') === 'sysid'
      ? 'sysid'
      : 'policy'
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
