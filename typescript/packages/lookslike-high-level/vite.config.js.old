// vite.config.js
import { defineConfig } from "vite";
import path from "path";
import { VitePWA } from "vite-plugin-pwa";

const commonPackages = [
  "@commontools/common-builder",
  "@commontools/common-runner",
  "@commontools/common-system",
  "@commontools/common-html",
  "@commontools/common-ui",
  "@commontools/common-runtime",
  "@commontools/llm-client",
];

export default defineConfig({
  build: {
    target: "esnext",
  },
  resolve: {
    preserveSymlinks: true,
    alias: Object.fromEntries(
      commonPackages.map(pkg => [
        pkg,
        path.resolve(__dirname, "..", pkg.replace("@commontools/", "")),
      ]),
    ),
  },
  optimizeDeps: {
    exclude: commonPackages,
  },
  server: {
    watch: {
      ignored: [
        "!**/src/**",
        "**/node_modules/**",
        "!**/node_modules/@commontools/**",
      ],
    },
    proxy: {
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
      "/api/data": {
        target: process.env.SYNOPSYS_API_URL ?? "http://localhost:8080",
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/data/, ""),
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
