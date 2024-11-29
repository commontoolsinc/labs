import { defineConfig } from "npm:@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 30000,
  webServer: {
    command: "deno task dev", // Adjust this to match your dev server command
    url: "http://localhost:5173",
    reuseExistingServer: true,
  },
  use: {
    baseURL: "http://localhost:5173",
  },
});
