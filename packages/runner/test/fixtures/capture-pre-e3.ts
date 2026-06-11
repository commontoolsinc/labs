// One-off capture script for the pre-E3 serialized-pattern fixture.
// Run: deno run -A test/fixtures/capture-pre-e3.ts (from packages/runner)
//
// The `preE3` vintage was captured BEFORE the $patternRef dual-write and is
// preserved verbatim when re-running (committed stored data does not change
// because the writer did). Re-running against the current checkout refreshes
// only the `dualWrite` vintage.
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

const fixtureUrl = new URL(
  "./pre-e3-serialized-pattern.json",
  import.meta.url,
);
let preE3 = serialized;
try {
  const existing = JSON.parse(await Deno.readTextFile(fixtureUrl));
  if (existing?.serialized?.preE3) preE3 = existing.serialized.preE3;
} catch {
  // First capture: the current writer IS the pre-E3 writer.
}

const fixture = {
  comment:
    "Stored pattern-VALUE vintages (PR E3). preE3: captured from the writer BEFORE the $patternRef dual-write — a bare node-graph; preserved verbatim on re-capture. dualWrite: the current writer's boundary output — $patternRef alongside the graph. Both must keep executing through the graph read paths (runtime.run on a deserialized graph; resolveOpPattern) for as long as stored data can carry them. Refresh dualWrite by re-running test/fixtures/capture-pre-e3.ts.",
  program: PROGRAM,
  serialized: { preE3, dualWrite: serialized },
};

await Deno.writeTextFile(
  fixtureUrl,
  JSON.stringify(fixture, null, 2) + "\n",
);
console.log("captured dualWrite keys:", Object.keys(serialized));

await runtime.dispose();
await storageManager.close();
