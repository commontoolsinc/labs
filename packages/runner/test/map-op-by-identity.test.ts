import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import {
  isPatternRefSentinel,
  resolveOpPattern,
} from "../src/builtins/op-pattern-ref.ts";

const signer = await Identity.fromPassphrase("map-op-by-identity");
const space = signer.did();

// Unit coverage for the sentinel shape + resolver, independent of the runtime.
describe("op-pattern-ref helpers", () => {
  it("recognizes a well-formed sentinel and rejects others", () => {
    expect(
      isPatternRefSentinel({
        $patternRef: { identity: "cf:module/x", symbol: "s" },
      }),
    ).toBe(true);
    expect(isPatternRefSentinel({ $patternRef: { identity: "x" } })).toBe(
      false,
    );
    expect(isPatternRefSentinel({ nodes: [] })).toBe(false);
    expect(isPatternRefSentinel(null)).toBe(false);
    expect(isPatternRefSentinel("x")).toBe(false);
  });

  it("resolves a sentinel via artifactFromIdentitySync", () => {
    const fakePattern = { argumentSchema: true } as never;
    const fakeRuntime = {
      patternManager: {
        artifactFromIdentitySync: (identity: string, symbol: string) => {
          expect(identity).toBe("cf:module/abc");
          expect(symbol).toBe("__cfPattern_1");
          return fakePattern;
        },
      },
    } as never;
    const resolved = resolveOpPattern(
      fakeRuntime,
      { $patternRef: { identity: "cf:module/abc", symbol: "__cfPattern_1" } },
      "map",
    );
    expect(resolved).toBe(fakePattern);
  });

  it("falls back to the embedded op graph when the sentinel misses the cache", () => {
    const fallbackGraph = { argumentSchema: true, nodes: [] } as never;
    const fakeRuntime = {
      patternManager: { artifactFromIdentitySync: () => undefined },
    } as never;
    const resolved = resolveOpPattern(
      fakeRuntime,
      {
        $patternRef: { identity: "cf:module/miss", symbol: "s" },
        $opFallback: fallbackGraph,
      },
      "map",
    );
    // Cache residency must not be a correctness requirement: an evicted op
    // resolves via the retained embedded graph rather than hard-failing.
    expect(resolved).toBe(fallbackGraph);
  });

  it("throws only when the sentinel misses AND has no embedded fallback", () => {
    const fakeRuntime = {
      patternManager: { artifactFromIdentitySync: () => undefined },
    } as never;
    expect(() =>
      resolveOpPattern(
        fakeRuntime,
        { $patternRef: { identity: "cf:module/miss", symbol: "s" } },
        "map",
      )
    ).toThrow(
      /op pattern cf:module\/miss#s is not in the evaluated-module cache/,
    );
  });

  it("passes a non-sentinel value through unchanged (legacy graph)", () => {
    const graph = { nodes: [], result: {} } as never;
    const resolved = resolveOpPattern({} as never, graph, "map");
    expect(resolved).toBe(graph);
  });
});

// End-to-end: under the ESM module loader, the `op` pattern of a `.map` node is
// passed by its content-addressed `{ identity, symbol }` reference (a
// `{ $patternRef }` sentinel) and resolved synchronously at runtime via
// `artifactFromIdentitySync`, instead of being deserialized from an embedded
// pattern graph.
describe("map op passed by identity (esmModuleLoader)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { esmModuleLoader: true },
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

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

  it("resolves the map op by identity and produces correct output", async () => {
    const compiled = await runtime.patternManager.compilePattern(PROGRAM);

    // Spy on the synchronous identity resolver to prove the op took the
    // `{ $patternRef }` path (not the embedded-graph fallback).
    const pm = runtime.patternManager;
    const original = pm.artifactFromIdentitySync.bind(pm);
    let identityResolves = 0;
    pm.artifactFromIdentitySync = (identity: string, symbol: string) => {
      identityResolves++;
      return original(identity, symbol);
    };

    const resultCell = runtime.getCell<{ vs: number[] }>(
      space,
      "map op by identity",
      compiled.resultSchema,
      tx,
    );
    const result = runtime.run(
      tx,
      compiled,
      { items: [{ v: 1 }, { v: 2 }, { v: 3 }] },
      resultCell,
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    tx = runtime.edit();
    // A map sets up its own scheduler actions; drive them with a sink + idle.
    const cancelSink = result.sink(() => {});
    await runtime.idle();

    expect(await result.key("vs").pull()).toEqual([1, 2, 3]);
    // The op was resolved by identity at least once (one per mapped row).
    expect(identityResolves).toBeGreaterThan(0);
    cancelSink();
  });

  it("falls back to the embedded op graph when the identity cache evicts the op", async () => {
    const compiled = await runtime.patternManager.compilePattern(PROGRAM);

    // Simulate the op's module being evicted from the bounded in-memory cache
    // before the map action runs: force every sync identity lookup to miss.
    // The map must still produce correct output via the retained `$opFallback`
    // graph — cache residency is an optimization, not a correctness requirement.
    const pm = runtime.patternManager;
    let identityMisses = 0;
    pm.artifactFromIdentitySync = () => {
      identityMisses++;
      return undefined;
    };

    const resultCell = runtime.getCell<{ vs: number[] }>(
      space,
      "map op fallback on eviction",
      compiled.resultSchema,
      tx,
    );
    const result = runtime.run(
      tx,
      compiled,
      { items: [{ v: 4 }, { v: 5 }, { v: 6 }] },
      resultCell,
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    tx = runtime.edit();
    const cancelSink = result.sink(() => {});
    await runtime.idle();

    expect(await result.key("vs").pull()).toEqual([4, 5, 6]);
    // The lookups missed (eviction simulated) yet the map still resolved the op.
    expect(identityMisses).toBeGreaterThan(0);
    cancelSink();
  });
});
