#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-run
import * as path from "@std/path";
import { build } from "@commontools/felt";

if (Deno.args.length < 1) {
  console.error("[USAGE]: bundle.ts path/to/entry.ts [dist/output.js]");
  Deno.exit(1);
}

const input = Deno.args[0];
const output = Deno.args[1] ?? path.join(Deno.cwd(), "dist", "index.js");

console.log(`Bundling graph at ${input} to ${output}...`);

await build({
  entryPoints: [input],
  outfile: output,
  tsconfigRaw: {
    compilerOptions: {
      experimentalDecorators: true,
    },
  },
});

console.log(`Successfully bundled!`);
