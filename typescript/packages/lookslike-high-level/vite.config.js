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
      commonPackages.map((pkg) => [
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
      "/api/llm": {
        target: process.env.PLANNING_API_URL ?? "http://localhost:8000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/llm/, ""),
      },
      "/api/img": {
        target: "https://ct-img.m4ke.workers.dev",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/img/, ""),
      },
      "/api/transcribe": {
        target: "https://voice.commontools.workers.dev",
        changeOrigin: true
      },
      "/api/reader": {
        target: "https://r.jina.ai/",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/reader/, ""),
      },
      "/api/data": {
        target: process.env.SYNOPSYS_API_URL ?? "http://localhost:8080",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/data/, ""),
      },
      "/api/blobby": {
        target:
          process.env.BLOBBY_API_URL ??
          "https://paas.saga-castor.ts.net/blobby",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/blobby/, ""),
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
