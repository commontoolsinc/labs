// vite.config.js
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "esnext"
  },
  resolve: {
    preserveSymlinks: true
  },
  optimizeDeps: {
    noDiscovery: true
  }
});
