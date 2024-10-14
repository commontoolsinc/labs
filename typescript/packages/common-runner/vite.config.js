// vite.config.js
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
  test: {
    environment: "node",
  },
});
