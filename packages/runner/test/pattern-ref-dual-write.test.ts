import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import type { Pattern } from "../src/builder/types.ts";
import {
  serializePatternGraph,
  toJSONWithLegacyAliases,
} from "../src/builder/json-utils.ts";
import {
  resolveOpPattern,
  resolveStoredPattern,
} from "../src/builtins/op-pattern-ref.ts";
import type { Opaque } from "../src/builder/types.ts";

/**
 * PR E3 (docs/specs/content-addressed-action-identity.md §7, scoped to
 * dual-write): the JSON BOUNDARY (`Pattern.toJSON()`, fired by JSON.stringify
 * and by cell writes via native-conversion's HasToJSON) emits the pattern's
 * content-addressed `{ identity, symbol }` as `$patternRef` ALONGSIDE the full
 * graph, while INTERNAL serialization (`serializePatternGraph`, used by
 * builder-time node serialization through `toJSONWithLegacyAliases`) stays a
 * bare graph — so `Pattern.nodes` and the `$opFallback` eviction fallback can
 * never silently become refs.
 */

const signer = await Identity.fromPassphrase("pattern-ref-dual-write");

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

describe("pattern $patternRef dual-write at the JSON boundary", () => {
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

  it("Pattern.toJSON() emits $patternRef alongside the full graph", async () => {
    const compiled = await runtime.patternManager.compilePattern(PROGRAM);
    const entryRef = runtime.patternManager.getArtifactEntryRef(compiled);
    expect(entryRef).toBeDefined();

    // The boundary serialization a pattern value undergoes when written to a
    // cell (native-conversion HasToJSON) or JSON.stringify'd.
    const serialized = JSON.parse(JSON.stringify(compiled));

    expect(serialized.$patternRef).toEqual({
      identity: entryRef!.identity,
      symbol: entryRef!.symbol,
    });
    // Dual-write: the graph stays alongside the ref (readers that cannot
    // resolve by identity — sync list builtins, cross-session llm-dialog —
    // keep working from the embedded graph).
    expect(Array.isArray(serialized.nodes)).toBe(true);
    expect(serialized.argumentSchema).toBeDefined();
    expect(serialized.resultSchema).toBeDefined();
  });

  it("$patternRef is content-derived: two compiles of identical bytes emit the same ref", async () => {
    const first = JSON.parse(
      JSON.stringify(await runtime.patternManager.compilePattern(PROGRAM)),
    );
    const second = JSON.parse(
      JSON.stringify(
        await runtime.patternManager.compilePattern({
          ...PROGRAM,
        }),
      ),
    );
    expect(first.$patternRef).toBeDefined();
    expect(first.$patternRef).toEqual(second.$patternRef);
  });

  it("internal graph serialization stays a bare graph even when the ref is known", async () => {
    const compiled = await runtime.patternManager.compilePattern(PROGRAM);
    expect(runtime.patternManager.getArtifactEntryRef(compiled)).toBeDefined();

    // serializePatternGraph is the internal serializer (builder-time nodes,
    // $opFallback): no $patternRef, full graph only.
    const internal = serializePatternGraph(compiled as unknown as Pattern);
    expect("$patternRef" in internal).toBe(false);
    expect(Array.isArray((internal as { nodes: unknown }).nodes)).toBe(true);

    // toJSONWithLegacyAliases routes pattern values through the internal
    // serializer — this is what keeps in-memory `Pattern.nodes` (and the
    // `$opFallback` graphs derived from them) ref-free.
    const viaLegacyAliases = toJSONWithLegacyAliases(
      compiled as unknown as Opaque<unknown>,
    ) as Record<string, unknown>;
    expect("$patternRef" in viaLegacyAliases).toBe(false);
  });

  it("nodes of a freshly compiled pattern embed bare op graphs (no $patternRef)", async () => {
    const compiled = await runtime.patternManager.compilePattern(PROGRAM);
    const json = JSON.stringify((compiled as unknown as Pattern).nodes);
    expect(json.includes("$patternRef")).toBe(false);
  });
});

describe("resolveOpPattern dual-read", () => {
  it("falls back to the carried graph when a ref+graph value misses the cache", () => {
    // A pattern VALUE serialized by the dual-write boundary carries BOTH
    // $patternRef and the full graph. When such a stored value reaches a list
    // builtin as its op (pattern-as-argument) and the identity cache has
    // evicted the module, the op must resolve from the value itself — not
    // hard-fail a running node.
    const dualWriteValue = {
      $patternRef: { identity: "cf:module/evicted", symbol: "s" },
      argumentSchema: true,
      resultSchema: true,
      result: {},
      nodes: [],
    } as never;
    const fakeRuntime = {
      patternManager: { artifactFromIdentitySync: () => undefined },
    } as never;
    const resolved = resolveOpPattern(fakeRuntime, dualWriteValue, "map");
    expect(resolved).toBe(dualWriteValue);
  });

  it("still throws when the value misses the cache and carries no graph", () => {
    const fakeRuntime = {
      patternManager: { artifactFromIdentitySync: () => undefined },
    } as never;
    expect(() =>
      resolveOpPattern(
        fakeRuntime,
        { $patternRef: { identity: "cf:module/miss", symbol: "s" } } as never,
        "map",
      )
    ).toThrow(/did not evaluate in this session/);
  });
});

describe("resolveStoredPattern (llm-dialog stored tool patterns)", () => {
  const refValue = {
    $patternRef: { identity: "cf:module/abc", symbol: "default" },
    argumentSchema: true,
    resultSchema: true,
    result: {},
    nodes: [],
  } as never;

  it("prefers the live canonical pattern when the identity cache hits", () => {
    const live = { argumentSchema: true } as never;
    const fakeRuntime = {
      patternManager: {
        artifactFromIdentitySync: (identity: string, symbol: string) => {
          expect(identity).toBe("cf:module/abc");
          expect(symbol).toBe("default");
          return live;
        },
      },
    } as never;
    expect(resolveStoredPattern(fakeRuntime, refValue)).toBe(live);
  });

  it("falls back to the carried graph on a cache miss", () => {
    const fakeRuntime = {
      patternManager: { artifactFromIdentitySync: () => undefined },
    } as never;
    expect(resolveStoredPattern(fakeRuntime, refValue)).toBe(refValue);
  });

  it("yields undefined for a bare unresolvable ref", () => {
    const fakeRuntime = {
      patternManager: { artifactFromIdentitySync: () => undefined },
    } as never;
    expect(
      resolveStoredPattern(
        fakeRuntime,
        { $patternRef: { identity: "cf:module/miss", symbol: "s" } },
      ),
    ).toBeUndefined();
  });

  it("passes plain stored graphs and nullish values through", () => {
    const graph = { nodes: [], result: {} };
    expect(resolveStoredPattern({} as never, graph)).toBe(graph);
    expect(resolveStoredPattern({} as never, undefined)).toBeUndefined();
    expect(resolveStoredPattern({} as never, null)).toBeUndefined();
  });
});
