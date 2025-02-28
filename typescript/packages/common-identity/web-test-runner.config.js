import { chromeLauncher } from "@web/test-runner-chrome";

const ED25519_FLAG = "--enable-experimental-web-platform-features";
export default {
  browsers: [
    chromeLauncher({
      launchOptions: {
        headless: true,
        devtools: true,
        args: [ED25519_FLAG],
      },
    }),
  ],
};
