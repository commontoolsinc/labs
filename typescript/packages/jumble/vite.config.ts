import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import deno from "../deno-vite-plugin/src/index.ts";
import tailwindcss from "@tailwindcss/vite";
import * as path from "@std/path";

// https://vite.dev/config/
export default defineConfig({
  plugins: [deno(), react(), tailwindcss()],
  server: {
    allowedHosts: [
      "localhost",
      "127.0.0.1",
      "bens-macbook-pro.saga-castor.ts.net",
    ],
    proxy: {
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
        target: process.env.MEMORY_URL ?? process.env.TOOLSHED_API_URL ??
          "http://localhost:8000/",
        ws: true,
        changeOrigin: true,
        rewriteWsOrigin: true,
      },
    },
    headers: {
      "Service-Worker-Allowed": "/data/",
    },
  },
});
