import { defineConfig } from "vite";
import { resolve } from "path";
import dts from "vite-plugin-dts";

// https://vitejs.dev/config/
export default defineConfig({
  build: { lib: { entry: resolve(__dirname, "src/index.ts") } },
  resolve: { alias: { src: resolve("src/") } },
  plugins: [dts()],
  server: {
    proxy: {
      "/api/ai/spell/fulfill": {
        target: process.env.TOOLSHED_API_URL ?? "http://localhost:8000/",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      "/api/ai/llm": {
        target: process.env.TOOLSHED_API_URL ?? "http://localhost:8000/api/ai/llm",
        changeOrigin: true,
      },
      "/api/ai/img": {
        target: process.env.TOOLSHED_API_URL ?? "http://localhost:8000/api/ai/img",
        changeOrigin: true,
      },
      "/api/ai/voice": {
        target: process.env.TOOLSHED_API_URL ?? "http://localhost:8000/api/ai/voice",
        changeOrigin: true,
      },
      "/api/ai/webreader": {
        target: process.env.TOOLSHED_API_URL ?? "http://localhost:8000/api/ai/webreader",
        changeOrigin: true,
      },
      "/api/storage/blobby": {
        target: process.env.TOOLSHED_API_URL ?? "http://localhost:8000/api/storage/blobby",
        changeOrigin: true,
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
