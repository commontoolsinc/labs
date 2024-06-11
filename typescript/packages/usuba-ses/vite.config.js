// vite.config.js
import { resolve } from 'path'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts';

export default defineConfig({
  plugins: [
    dts()
  ],
  build: {
    target: 'esnext',
    lib: {
      type: "module",
      entry: resolve(__dirname, 'lib/index.js'),
      name: 'UsubaSES',
      fileName: 'usuba-ses',
      module: "./dist/usuba-ses.js"
    }
  },
  define: {
    'process.env.BABEL_TYPES_8_BREAKING': '0',
    'process.env.BABEL_8_BREAKING': '0',
    'Buffer': 'Uint8Array'
  },
  resolve: {
    preserveSymlinks: true
  }
})