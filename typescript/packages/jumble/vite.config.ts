import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // NOTE: We need to import local modules from the pnpm workspace.
      "@commontools/ui": path.resolve(__dirname, "../common-ui/src/index.ts"),
    },
  },
});
