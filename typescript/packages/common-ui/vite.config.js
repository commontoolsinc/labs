// https://vitejs.dev/guide/build.html#multi-page-app
// https://willschenk.com/labnotes/2024/shoelace_and_vite/
// https://shoelace.style/tutorials/integrating-with-laravel/
import { resolve } from "path";
import { defineConfig } from "vite";

export default defineConfig({
  test: {
    browser: {
      enabled: true,
      provider: "playwright",
      headless: true,
      name: "chromium",
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "examples/index.html"),
        components: resolve(__dirname, "examples/components.html"),
      },
    },
  },
});
