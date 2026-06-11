// One-off capture script for the pre-E3 serialized-pattern fixture.
// Run: deno run -A test/fixtures/capture-pre-e3.ts (from packages/runner)
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../../src/runtime.ts";
import type { RuntimeProgram } from "../../src/harness/types.ts";

const signer = await Identity.fromPassphrase("pre-e3-pattern-value-canary");

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        "export default pattern<{ items: { v: number }[] }>(({ items }) => {",
        "  return { vs: items.map((item) => item.v) };",
        "});",
      ].join("\n"),
    },
  ],
};

const storageManager = StorageManager.emulate({ as: signer });
const runtime = new Runtime({
  apiUrl: new URL(import.meta.url),
  storageManager,
});

const compiled = await runtime.patternManager.compilePattern(PROGRAM);
await runtime.idle();

// JSON.stringify fires Pattern.toJSON() — the exact serialization a pattern
// value undergoes when written to a cell (native-conversion HasToJSON).
const serialized = JSON.parse(JSON.stringify(compiled));

const fixture = {
  comment:
    "Captured by PR E3 from the PRE-E3 writer (patternToJSON before $patternRef dual-write). A stored pattern VALUE of this vintage is a bare node-graph with no $patternRef; it must keep executing through the graph read paths (runtime.run on a deserialized graph; resolveOpPattern legacy branch) for as long as stored data can carry it. Regenerate by re-running test/fixtures/capture-pre-e3.ts against a pre-E3 checkout.",
  program: PROGRAM,
  serialized: { preE3: serialized },
};

await Deno.writeTextFile(
  new URL("./pre-e3-serialized-pattern.json", import.meta.url),
  JSON.stringify(fixture, null, 2) + "\n",
);
console.log("captured", Object.keys(serialized));

await runtime.dispose();
await storageManager.close();
