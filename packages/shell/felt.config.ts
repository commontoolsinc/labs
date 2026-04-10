import { type Config } from "@commonfabric/felt";
import ports from "@commonfabric/ports" with { type: "json" };

const PRODUCTION = !!Deno.env.get("PRODUCTION");
const ENVIRONMENT = PRODUCTION ? "production" : "development";

const SHELL_PORT = parseInt(
  Deno.env.get("SHELL_PORT") || String(ports.shell),
  10,
);

const config: Config = {
  entries: [
    { in: "src/index.ts", out: "scripts/index" },
    {
      in: "../runtime-client/backends/web-worker/index.ts",
      // Changing this path requires a matching update in
      // packages/shell/src/lib/runtime.ts (fetchBuildHash).
      out: "scripts/worker-runtime",
    },
  ],
  outDir: "dist",
  hostname: "127.0.0.1",
  port: SHELL_PORT,
  publicDir: "public",
  watchDir: "src",
  redirectToIndex:
    /^\/(?!((assets|scripts|styles|static|fonts)\/.*|build-manifest\.json))/,
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
      "$MEMORY_VERSION": Deno.env.get("CF_INTEGRATION_MEMORY_VERSION"),
      "$EXPERIMENTAL_MODERN_DATA_MODEL": Deno.env.get(
        "EXPERIMENTAL_MODERN_DATA_MODEL",
      ),
      "$EXPERIMENTAL_UNIFIED_JSON_ENCODING": Deno.env.get(
        "EXPERIMENTAL_UNIFIED_JSON_ENCODING",
      ),
      "$EXPERIMENTAL_MODERN_HASH": Deno.env.get(
        "EXPERIMENTAL_MODERN_HASH",
      ),
      "$EXPERIMENTAL_MODERN_SCHEMA_HASH": Deno.env.get(
        "EXPERIMENTAL_MODERN_SCHEMA_HASH",
      ),
      "$COMPILATION_CACHE_CLIENT": Deno.env.get(
        "COMPILATION_CACHE_CLIENT",
      ) ?? "true",
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
