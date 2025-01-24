import { defineConfig } from "vite";
import { resolve } from "path";
import dts from "vite-plugin-dts";

// https://vitejs.dev/config/
export default defineConfig({
  build: { lib: {
    entry: resolve(__dirname, "src/index.ts"),
    // We need a name when building as umd/iife, which web-test-runner does
    name: "common-ui"
  }},
  resolve: { alias: { src: resolve("src/") } },
  plugins: [dts()],
});
