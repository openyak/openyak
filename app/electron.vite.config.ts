import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()], build: { rollupOptions: { input: {
    index: resolve('src/main/index.ts'),
    'runtime-worker': resolve('src/main/runtime/worker.ts'),
  } } } },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: { plugins: [react()] },
})
