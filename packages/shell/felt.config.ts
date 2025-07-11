import { type Config } from "@commontools/felt";

const PRODUCTION = !!Deno.env.get("PRODUCTION");
const ENVIRONMENT = PRODUCTION ? "production" : "development";

const config: Config = {
  entry: "src/index.ts",
  out: "scripts/index.js",
  outDir: "dist",
  hostname: "127.0.0.1",
  port: 5173,
  publicDir: "public",
  watchDir: "src",
  redirectToIndex: /^\/(?!(((assets)|(scripts)|(styles))\/.*))/,
  esbuild: {
    sourcemap: !PRODUCTION,
    minify: PRODUCTION,
    external: [
      "jsdom",
      "source-map-support",
      "canvas",
      "inspector",
    ],
    define: {
      "$ENVIRONMENT": ENVIRONMENT,
      "$API_URL": Deno.env.get("API_URL"),
      "$COMMIT_SHA": Deno.env.get("COMMIT_SHA"),
    },
    tsconfigRaw: {
      compilerOptions: {
        // `useDefineForClassFields` is critical when using Lit
        // with esbuild, even when not using decorators.
        useDefineForClassFields: false,
        experimentalDecorators: true,
      },
    },
  },
};
export default config;
