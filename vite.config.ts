import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'
import { fileURLToPath } from 'node:url'

// One codebase, per-platform entry folders (app/web, app/tauri). `--mode tauri`
// builds the desktop frontend; default builds the static web app. Shared logic
// lives in app/shared. Both output to dist/ (Tauri bundles it).
export default defineConfig(({ mode }) => ({
  root: mode === 'tauri' ? 'app/tauri' : 'app/web',
  plugins: [preact()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./app/shared', import.meta.url)),
    },
  },
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
  },
}))
