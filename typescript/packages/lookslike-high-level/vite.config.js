// vite.config.js
import { defineConfig } from "vite";
import path from "path";

const commonPackages = [
  "@commontools/common-builder",
  "@commontools/common-runner",
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
      ])
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
        target: "http://localhost:8000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/llm/, ""),
      },
      "/api/data": {
        target: "http://localhost:8080",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/data/, ""),
      },
    },
    headers: {
      "*.wasm": {
        "Content-Type": "application/wasm",
      },
    },
  },
  test: {
    environment: "jsdom",
  },
});
