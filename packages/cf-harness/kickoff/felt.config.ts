import { type Config } from "@commonfabric/felt";

/**
 * The kickoff page's build. The page is served by the kickoff server itself
 * rather than by felt, so only `build` is used here: `port` and `hostname`
 * belong to felt's own dev server, which this surface does not run.
 */
const config: Config = {
  entries: [{ in: "src/index.ts", out: "scripts/index" }],
  outDir: "dist",
  publicDir: "public",
  watchDir: "src",
  esbuild: {
    sourcemap: true,
    minify: false,
    tsconfigRaw: {
      compilerOptions: {
        // `useDefineForClassFields` is critical when using Lit with esbuild,
        // even when not using decorators.
        useDefineForClassFields: false,
      },
    },
  },
};
export default config;
