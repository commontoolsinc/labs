/// <reference lib="deno.ns" />

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import deno from "../deno-vite-plugin/src/index.ts";
import tailwindcss from "@tailwindcss/vite";
import * as path from "@std/path";

const buildSourcemaps = Deno.env.get("VITE_BUILD_SOURCEMAPS") === "true";
console.log("TOOLSHED_API_URL", Deno.env.get("TOOLSHED_API_URL"));
console.log("Build source maps:", buildSourcemaps);

// https://vite.dev/config/
export default defineConfig({
  esbuild: {
    tsconfigRaw: {
      compilerOptions: {
        experimentalDecorators: true,
      },
   },
  },
  plugins: [deno(), react(), tailwindcss() as any],
  server: {
    allowedHosts: [
      "localhost",
      "127.0.0.1",
      "bens-macbook-pro.saga-castor.ts.net",
      "jake.saga-castor.ts.net",
    ],
    proxy: {
      "/api/integrations": {
        target: Deno.env.get("INTEGRATIONS_URL") ??
          Deno.env.get("TOOLSHED_API_URL") ?? "http://localhost:8000/",
        changeOrigin: true,
      },
      "/api/ai/spell/": {
        target: Deno.env.get("AI_URL") ??
          Deno.env.get("TOOLSHED_API_URL") ??
          "http://localhost:8000/",
        changeOrigin: true,
      },
      "/api/spellbook": {
        target: Deno.env.get("TOOLSHED_API_URL") ?? "http://localhost:8000/",
        changeOrigin: true,
      },
      "/api/whoami": {
        target: Deno.env.get("TOOLSHED_API_URL") ?? "http://localhost:8000/",
        changeOrigin: true,
      },
      "/api/ai/llm": {
        target: Deno.env.get("AI_URL") ??
          Deno.env.get("TOOLSHED_API_URL") ??
          "http://localhost:8000/",
        changeOrigin: true,
      },
      "/api/ai/img": {
        target: Deno.env.get("AI_URL") ??
          Deno.env.get("TOOLSHED_API_URL") ??
          "http://localhost:8000/",
        changeOrigin: true,
      },
      "/api/ai/voice": {
        target: Deno.env.get("AI_URL") ??
          Deno.env.get("TOOLSHED_API_URL") ??
          "http://localhost:8000/",
        changeOrigin: true,
      },
      "/api/ai/webreader": {
        target: Deno.env.get("AI_URL") ??
          Deno.env.get("TOOLSHED_API_URL") ??
          "http://localhost:8000/",
        changeOrigin: true,
      },
      "/api/storage/blobby": {
        target: Deno.env.get("MEMORY_URL") ??
          Deno.env.get("TOOLSHED_API_URL") ??
          "http://localhost:8000/",
        changeOrigin: true,
      },
      "/api/storage/memory": {
        target: Deno.env.get("MEMORY_URL") ??
          Deno.env.get("TOOLSHED_API_URL") ??
          "http://localhost:8000/",
        ws: true,
        changeOrigin: true,
        rewriteWsOrigin: true,
      },
      "/static": {
        target: Deno.env.get("STATIC_URL") ??
          Deno.env.get("TOOLSHED_API_URL") ??
          "http://localhost:8000",
        changeOrigin: true,
      },
    },
    headers: {
      "Service-Worker-Allowed": "/data/",
      "access-control-allow-origin": "*",
    },
  },
  build: {
    sourcemap: buildSourcemaps,
  },
});
