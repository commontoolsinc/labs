import { defineConfig } from "vite";
import { resolve } from "path";
import dts from "vite-plugin-dts";

// https://vitejs.dev/config/
export default defineConfig({
  build: { lib: { entry: resolve(__dirname, "src/main.ts"), formats: ["es"] } },
  resolve: { alias: { src: resolve("src/") } },
  plugins: [dts()],
  server: {
    proxy: {
      "/api/ai/spell/fulfill": {
        target: process.env.TOOLSHED_API_URL ?? "http://localhost:8000/",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      "/api/ai/spell/search": {
        target: process.env.TOOLSHED_API_URL ?? "http://localhost:8000/",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
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
        target: process.env.TOOLSHED_API_URL ?? "http://localhost:8001/",
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
  test: {
    environment: "node",
  },
});
