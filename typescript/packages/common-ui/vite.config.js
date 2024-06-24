// https://vitejs.dev/guide/build.html#multi-page-app
import { resolve } from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'examples/index.html'),
        components: resolve(__dirname, 'examples/components.html'),
      },
    },
  },
})