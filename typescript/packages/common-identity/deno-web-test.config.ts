const ED25519_FLAG = "--enable-experimental-web-platform-features";
export default {
  astral: {
    product: "chrome",
    args: [ED25519_FLAG],
    headless: true,
  }
};
