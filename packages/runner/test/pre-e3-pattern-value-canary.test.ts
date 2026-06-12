import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { Pattern } from "../src/builder/types.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import {
  resolveOpPattern,
  resolveStoredPattern,
} from "../src/builtins/op-pattern-ref.ts";

/**
 * PR E3 stored-pattern-value canary (docs/specs/content-addressed-action-
 * identity.md §7): pattern VALUES persisted to cells before the `$patternRef`
 * dual-write are bare node-graphs — no ref, no `$opFallback`. Two production
 * read paths consume them as graphs:
 *
 *  - `runtime.run` on a deserialized graph (llm-dialog tool invocation reads
 *    `toolDef.pattern` raw from a cell and runs it), and
 *  - the list builtins' legacy branch (`resolveOpPattern` passes a
 *    non-sentinel graph through unchanged).
 *
 * The fixture was captured from the pre-E3 writer and committed verbatim
 * (test/fixtures/pre-e3-serialized-pattern.json). It must keep loading and
 * EXECUTING for as long as stored data can carry that vintage — this test is
 * the tripwire against a refs-only `Pattern.toJSON()` (or a reader change)
 * silently dropping the graph read path stored data still needs.
 */

const signer = await Identity.fromPassphrase("pre-e3-pattern-value-canary");
const space = signer.did();

const fixture = JSON.parse(
  Deno.readTextFileSync(
    new URL("./fixtures/pre-e3-serialized-pattern.json", import.meta.url),
  ),
) as {
  program: RuntimeProgram;
  serialized: Record<string, Record<string, unknown>>;
};

describe("pre-E3 stored pattern-value canary", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  const setup = () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  };

  const runGraph = async (graph: Pattern, cause: string) => {
    let tx = runtime!.edit();
    const resultCell = runtime!.getCell<{ vs: number[] }>(
      space,
      cause,
      graph.resultSchema,
      tx,
    );
    const result = runtime!.run(
      tx,
      graph,
      { items: [{ v: 7 }, { v: 8 }, { v: 9 }] },
      resultCell,
    );
    runtime!.prepareTxForCommit(tx);
    await tx.commit();
    tx = runtime!.edit();
    const cancelSink = result.sink(() => {});
    await runtime!.idle();
    const vs = await result.key("vs").pull();
    cancelSink();
    await tx.commit();
    return vs;
  };

  it("pre-E3 vintage (bare graph, no $patternRef) still executes via runtime.run", async () => {
    setup();
    const graph = fixture.serialized.preE3 as unknown as Pattern;
    expect("$patternRef" in graph).toBe(false);
    expect(Array.isArray(graph.nodes)).toBe(true);

    // What llm-dialog's invoke does with a stored toolDef pattern: parse the
    // cell value as a graph and run it. NOTE: deliberately no compile of the
    // fixture program first — a stored graph must run without its module ever
    // having been evaluated in this session.
    const vs = await runGraph(structuredClone(graph), "canary-pre-e3-run");
    expect(vs).toEqual([7, 8, 9]);
  });

  it("pre-E3 vintage passes through resolveOpPattern's legacy graph branch", () => {
    setup();
    const graph = structuredClone(
      fixture.serialized.preE3,
    ) as unknown as Pattern;
    const resolved = resolveOpPattern(runtime!, graph, "map");
    expect(resolved).toBe(graph);
  });

  it("dual-write vintage ($patternRef + graph) still executes via runtime.run", async () => {
    setup();
    const graph = fixture.serialized.dualWrite as unknown as Pattern;
    expect("$patternRef" in graph).toBe(true);
    expect(Array.isArray(graph.nodes)).toBe(true);

    // Again no compile first: the module is NOT in this session's identity
    // index, so execution must come from the carried graph.
    const vs = await runGraph(
      structuredClone(graph),
      "canary-dual-write-run",
    );
    expect(vs).toEqual([7, 8, 9]);
  });

  it("dual-write vintage resolves from its carried graph on an identity-cache miss", () => {
    setup();
    const value = structuredClone(
      fixture.serialized.dualWrite,
    ) as unknown as Pattern;
    // Fresh runtime: nothing is in the identity index, so the sentinel-shaped
    // value must resolve from the graph it carries.
    const resolved = resolveOpPattern(runtime!, value, "map");
    expect(resolved).toBe(value);
  });

  it("refs-only vintage (E4) resolves to the live canonical once its module evaluated", async () => {
    setup();
    const stored = structuredClone(fixture.serialized.refsOnly);
    expect("nodes" in stored).toBe(false);

    // The module evaluates in this session (the by-construction case: any
    // piece whose pattern mentions this one loads it as part of its bundle).
    const compiled = await runtime!.patternManager.compilePattern(
      fixture.program,
    );
    const resolved = resolveStoredPattern(runtime!, stored);
    expect(resolved).toBe(compiled);

    const vs = await runGraph(resolved as Pattern, "canary-refs-only-run");
    expect(vs).toEqual([7, 8, 9]);
  });

  it("refs-only vintage loads by identity from storage when the module never evaluated (async net)", async () => {
    // Session 1 compiles WITH the space cache: compiled artifacts persist
    // in-space as an expected part of compilation (E4 invariant). It stays
    // open while session 2 reads — the emulated storage tears down replica
    // state on dispose (same structure as resume-by-identity.test.ts).
    storageManager = StorageManager.emulate({ as: signer });
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const tx1 = rt1.edit();
      await rt1.patternManager.compilePattern(fixture.program, {
        space,
        tx: tx1,
      });
      await tx1.commit();
      // No flushCompileCacheWrites: the cold write-back is awaited INSIDE
      // compilePattern (the E4 persistence contract) — deliberately not
      // flushed here to pin that.
      await rt1.storageManager.synced();

      // Session 2 never evaluates the module; the stored refs-only value's
      // sync resolution misses, and the async fallback (what llm-dialog does)
      // loads source-free by identity from the persisted compiled artifacts.
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      const stored = structuredClone(
        fixture.serialized.refsOnly,
      ) as unknown as {
        $patternRef: { identity: string; symbol: string };
      };
      expect(resolveStoredPattern(runtime, stored)).toBeUndefined();

      const loaded = await runtime.patternManager.loadPatternByIdentity(
        stored.$patternRef.identity,
        stored.$patternRef.symbol,
        space,
      );
      expect(loaded).toBeDefined();

      const vs = await runGraph(loaded as Pattern, "canary-refs-only-async");
      expect(vs).toEqual([7, 8, 9]);
    } finally {
      await rt1.dispose();
    }
  });
});
