// vite.config.js
import { resolve } from "path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "esnext",
  },
  resolve: {
    preserveSymlinks: true,
  },
  optimizeDeps: {
    noDiscovery: true,
  },
  server: {
    proxy: {
      "/api/llm": {
        target: "http://localhost:8000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/llm/, ""),
      },
    },
  },
});
