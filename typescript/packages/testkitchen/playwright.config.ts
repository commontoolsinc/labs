import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 30000,
  use: {
    baseURL: "http://localhost:5173",
    headless: false,
  },
});
