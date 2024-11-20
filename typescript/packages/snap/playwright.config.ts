import type { PlaywrightTestConfig } from "@playwright/test";

const config: PlaywrightTestConfig = {
  testDir: "./tests",
  timeout: 30000,
  use: {
    baseURL: "http://localhost:5173",
    headless: true,
  },
  // Disable all reporters to prevent disk writes
  reporter: 'null',
};

export default config; 