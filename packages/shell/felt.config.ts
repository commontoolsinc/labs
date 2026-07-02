import { type Config } from "@commonfabric/felt";
import { computeCurrentCompilerVersion } from "../runner/src/compilation-cache/compiler-fingerprint.deno.ts";
import ports from "@commonfabric/ports" with { type: "json" };

const PRODUCTION = !!Deno.env.get("PRODUCTION");
const ENVIRONMENT = PRODUCTION ? "production" : "development";
const COMPILE_CACHE_RUNTIME_VERSION = await computeCurrentCompilerVersion();

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
    /^\/(?!((assets|scripts|styles|static|fonts)\/.*|build-manifest\.json|manifest\.webmanifest|sw\.js))/,
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
      "$EXPERIMENTAL_MODERN_CELL_REP": Deno.env.get(
        "EXPERIMENTAL_MODERN_CELL_REP",
      ),
      "$EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE": Deno.env.get(
        "EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE",
      ),
      "$EXPERIMENTAL_COMPUTED_CELL_IDS": Deno.env.get(
        "EXPERIMENTAL_COMPUTED_CELL_IDS",
      ),
      "globalThis.__cfCompileCacheRuntimeVersion":
        COMPILE_CACHE_RUNTIME_VERSION,
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
      },
    },
    logOverride: {
      "direct-eval": "silent",
    },
  },
};
export default config;
