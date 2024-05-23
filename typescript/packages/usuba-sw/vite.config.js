// vite.config.js
import { resolve } from 'path'
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    target: 'esnext',
    lib: {
      type: "module",
      entry: resolve(__dirname, 'lib/index.js'),
      name: 'UsubaServiceWorker',
      fileName: 'usuba-sw',
      module: "./dist/usuba-sw.js"
    }
  },
  resolve: {
    preserveSymlinks: true
  }
})