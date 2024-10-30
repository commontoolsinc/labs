// https://vitejs.dev/guide/build.html#multi-page-app
// https://willschenk.com/labnotes/2024/shoelace_and_vite/
// https://shoelace.style/tutorials/integrating-with-laravel/
import { resolve } from "path";
import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

const iconsPath =
  "../../node_modules/@shoelace-style/shoelace/dist/assets/icons";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /\/assets\/icons\/(.+)/,
        replacement: `${iconsPath}/$1`,
      },
    ],
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "examples/index.html"),
        components: resolve(__dirname, "examples/components.html"),
      },
    },
  },
  plugins: [
    viteStaticCopy({
      targets: [
        {
          src: iconsPath,
          dest: "assets",
        },
      ],
    }),
  ],
});
