#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-run
import * as path from "@std/path";
import * as esbuild from "esbuild";
import { denoPlugins } from "@luca/esbuild-deno-loader";

if (Deno.args.length < 1) {
  console.error("[USAGE]: bundle.ts path/to/entry.ts [dist/output.js]");
  Deno.exit(1);
}

const entry = Deno.args[0];
const out = Deno.args[1] ?? path.join(Deno.cwd(), "dist", "index.js");

console.log(`Bundling graph at ${entry} to ${out}...`);

const result = await esbuild.build({
  plugins: [...denoPlugins()],
  entryPoints: [entry],
  outfile: out,
  bundle: true,
  format: "esm",
  // Explicitly compile decorators, as this what Jumble->Vite
  // does, and no browsers currently support (any form of) decorators,
  // and if we're bundling, we're probably running in a browser.
  tsconfigRaw: {
    compilerOptions: {
      experimentalDecorators: true,
    },
  },
});

esbuild.stop();

console.log(`Successfully bundled!`);
