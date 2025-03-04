import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import deno from "../deno-vite-plugin/src/index.ts";
import tailwindcss from "@tailwindcss/vite";
import * as path from "@std/path";

console.log("TOOLSHED_API_URL", Deno.env.get("TOOLSHED_API_URL"));
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
      "/api/integrations": {
        target: Deno.env.get("TOOLSHED_API_URL") ?? "http://localhost:8000/",
        changeOrigin: true,
      },
      "/api/ai/spell/": {
        target: Deno.env.get("TOOLSHED_API_URL") ?? "http://localhost:8000/",
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
        target: Deno.env.get("TOOLSHED_API_URL") ?? "http://localhost:8000/",
        changeOrigin: true,
      },
      "/api/ai/img": {
        target: Deno.env.get("TOOLSHED_API_URL") ?? "http://localhost:8000/",
        changeOrigin: true,
      },
      "/api/ai/voice": {
        target: Deno.env.get("TOOLSHED_API_URL") ?? "http://localhost:8000/",
        changeOrigin: true,
      },
      "/api/ai/webreader": {
        target: Deno.env.get("TOOLSHED_API_URL") ?? "http://localhost:8000/",
        changeOrigin: true,
      },
      "/api/storage/blobby": {
        target: Deno.env.get("TOOLSHED_API_URL") ?? "http://localhost:8000/",
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
    },
    headers: {
      "Service-Worker-Allowed": "/data/",
    },
  },
});
