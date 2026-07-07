import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

/**
 * Regression for the CLI pattern-tool direct-invocation path
 * (`cf piece call <piece> <patternToolField> -- --query tea`).
 *
 * A `patternTool(pattern, extraParams)` stores its `pattern` field as the JSON
 * BOUNDARY form (`Pattern.toJSON()`, identity E4): `{ $patternRef,
 * argumentSchema, resultSchema }` with NO `nodes`/`result`/
 * `derivedInternalCells`. The CLI reads that stored value back and hands it
 * straight to `runtime.run` (see `executeResolvedCallable` in
 * packages/cli/lib/callable.ts). Before the fix, `run` → `setupInternal` →
 * `patternNeedsOneShotPull(pattern)` reached `pattern.nodes.some(...)` on the
 * ref-only value, whose `nodes` is `undefined`, throwing
 * `Cannot read properties of undefined (reading 'some')`.
 *
 * `resolveSetupPattern` now resolves a `$patternRef` sentinel back to the live
 * canonical (the object carrying the full graph) before any graph field is
 * read — the same resolution llm-dialog's tool invocation already performs via
 * `resolveStoredPatternAsync` before it calls `runtime.run`.
 */

const signer = await Identity.fromPassphrase("pattern-tool-invoke-boundary");
const space = signer.did();

// A standalone sub-pattern shaped like fuse-exec's `searchTool`: it takes a
// query + a (pre-filled via extraParams) source and computes a summary. The
// `lift` gives it an interpreted node so running it actually reads the graph.
const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { pattern, lift } from 'commonfabric';",
        "const combine = lift(",
        "  ({ source, query }: { source: string; query: string }) =>",
        "    `${source}:${query}`,",
        ");",
        "export default pattern<{ query: string; source: string }>(",
        "  ({ query, source }) => ({",
        "    query,",
        "    source,",
        "    summary: combine({ source, query }),",
        "  }),",
        ");",
      ].join("\n"),
    },
  ],
};

describe("patternTool direct invocation of a boundary-form pattern value", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("runs a stored ref-only pattern value by resolving it to the live canonical", async () => {
    const compiled = await runtime.patternManager.compilePattern(PROGRAM);
    expect(runtime.patternManager.getArtifactEntryRef(compiled)).toBeDefined();

    // The value the CLI reads back from the cell: the JSON boundary form the
    // `patternTool` pattern field is serialized as. Confirm it is genuinely
    // ref-only — the whole premise of the bug is a missing graph.
    const stored = JSON.parse(JSON.stringify(compiled)) as Record<
      string,
      unknown
    >;
    expect(stored.$patternRef).toBeDefined();
    expect("nodes" in stored).toBe(false);
    expect("result" in stored).toBe(false);

    const resultCell = runtime.getCell(space, "pattern-tool-boundary-run");

    // Exactly what `executeResolvedCallable` does: hand the stored boundary
    // form straight to `runtime.run`. Before the fix this threw
    // "Cannot read properties of undefined (reading 'some')".
    const result = runtime.run(
      undefined,
      stored as never,
      { query: "tea", source: "bound-source" } as never,
      resultCell as never,
    );
    await runtime.idle();
    const value = JSON.parse(JSON.stringify(await result.pull()));

    expect(value).toEqual({
      query: "tea",
      source: "bound-source",
      summary: "bound-source:tea",
    });
  });
});
