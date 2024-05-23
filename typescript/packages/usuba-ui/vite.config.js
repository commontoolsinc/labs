// vite.config.js
import { resolve } from 'path'
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    target: 'esnext'
  },
  resolve: {
    preserveSymlinks: true
  }
})