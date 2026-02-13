import { type Config } from "@commontools/felt";

const PRODUCTION = !!Deno.env.get("PRODUCTION");
const ENVIRONMENT = PRODUCTION ? "production" : "development";

const SHELL_PORT = parseInt(Deno.env.get("SHELL_PORT") || "5173", 10);

const config: Config = {
  entries: [
    { in: "src/index.ts", out: "scripts/index" },
    {
      in: "../runtime-client/backends/web-worker/index.ts",
      out: "scripts/worker-runtime",
    },
  ],
  outDir: "dist",
  hostname: "127.0.0.1",
  port: SHELL_PORT,
  publicDir: "public",
  watchDir: "src",
  redirectToIndex: /^\/(?!((assets|scripts|styles|static)\/.*))/,
  staticDirs: [
    { from: "../static/assets", to: "/static" },
  ],
  esbuild: {
    sourcemap: !PRODUCTION,
    minify: PRODUCTION,
    external: [
      "source-map-support",
      "canvas",
      "inspector",
    ],
    define: {
      "$ENVIRONMENT": ENVIRONMENT,
      "$API_URL": Deno.env.get("API_URL"),
      "$COMMIT_SHA": Deno.env.get("COMMIT_SHA"),
      "$EXPERIMENTAL_RICH_STORABLE_VALUES": Deno.env.get(
        "EXPERIMENTAL_RICH_STORABLE_VALUES",
      ),
      "$EXPERIMENTAL_STORABLE_PROTOCOL": Deno.env.get(
        "EXPERIMENTAL_STORABLE_PROTOCOL",
      ),
      "$EXPERIMENTAL_UNIFIED_JSON_ENCODING": Deno.env.get(
        "EXPERIMENTAL_UNIFIED_JSON_ENCODING",
      ),
    },
    supported: {
      // Provide polyfills for `using` resource management
      using: false,
    },
    tsconfigRaw: {
      compilerOptions: {
        // `useDefineForClassFields` is critical when using Lit
        // with esbuild, even when not using decorators.
        useDefineForClassFields: false,
        experimentalDecorators: true,
      },
    },
    logOverride: {
      "direct-eval": "silent",
    },
  },
};
export default config;
