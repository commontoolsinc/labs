import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    allowedHosts: ["localhost", "127.0.0.1", "bens-macbook-pro.saga-castor.ts.net"],
    proxy: {
      "/api/integrations": {
        target: process.env.TOOLSHED_API_URL ?? "http://localhost:8000/",
        changeOrigin: true,
      },
      "/api/ai/spell/": {
        target: process.env.TOOLSHED_API_URL ?? "http://localhost:8000/",
        changeOrigin: true,
      },
      "/api/spellbook": {
        target: process.env.TOOLSHED_API_URL ?? "http://localhost:8000/",
        changeOrigin: true,
      },
      "/api/whoami": {
        target: process.env.TOOLSHED_API_URL ?? "http://localhost:8000/",
        changeOrigin: true,
      },
      "/api/ai/llm": {
        target: process.env.TOOLSHED_API_URL ?? "http://localhost:8000/",
        changeOrigin: true,
      },
      "/api/ai/img": {
        target: process.env.TOOLSHED_API_URL ?? "http://localhost:8000/",
        changeOrigin: true,
      },
      "/api/ai/voice": {
        target: process.env.TOOLSHED_API_URL ?? "http://localhost:8000/",
        changeOrigin: true,
      },
      "/api/ai/webreader": {
        target: process.env.TOOLSHED_API_URL ?? "http://localhost:8000/",
        changeOrigin: true,
      },
      "/api/storage/blobby": {
        target: process.env.TOOLSHED_API_URL ?? "http://localhost:8000/",
        changeOrigin: true,
      },
      "/api/storage/memory": {
        target: process.env.MEMORY_URL ?? process.env.TOOLSHED_API_URL ?? "http://localhost:8000/",
        ws: true,
        changeOrigin: true,
        rewriteWsOrigin: true,
      },
    },
    headers: {
      "*.wasm": {
        "Content-Type": "application/wasm",
      },
      "Service-Worker-Allowed": "/data/",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // NOTE: We need to import local modules from the pnpm workspace.
      "@commontools/ui": path.resolve(__dirname, "../common-ui/src/index.ts"),
    },
  },
});
