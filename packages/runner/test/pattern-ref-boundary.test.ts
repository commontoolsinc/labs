import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import type { Pattern } from "../src/builder/types.ts";
import {
  patternToJSON,
  serializePatternGraph,
  toJSONWithLegacyAliases,
} from "../src/builder/json-utils.ts";
import {
  resolveOpPattern,
  resolveStoredPattern,
  resolveStoredPatternAsync,
} from "../src/builtins/op-pattern-ref.ts";
import type { FactoryInput } from "../src/builder/types.ts";

/**
 * Identity E4 (docs/specs/content-addressed-action-identity.md §7): the JSON
 * BOUNDARY (`Pattern.toJSON()`, fired by JSON.stringify and by cell writes via
 * native-conversion's HasToJSON) is REFS-ONLY — `{ $patternRef, argumentSchema,
 * resultSchema }`, no graph. Rehydration of a stored ref goes by identity: the
 * session-lifetime artifact index (sync) or the storage-backed
 * `loadPatternByIdentity` (async; compiled artifacts persist in-space as part
 * of compilation). INTERNAL serialization (`serializePatternGraph`, used by
 * builder-time node serialization through `toJSONWithLegacyAliases`) stays the
 * full bare graph — `Pattern.nodes` is the in-memory instantiation
 * representation, not a wire format.
 */

const signer = await Identity.fromPassphrase("pattern-ref-boundary");

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

describe("refs-only pattern JSON at the boundary", () => {
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

  it("Pattern.toJSON() emits the ref + schemas and NO graph", async () => {
    const compiled = await runtime.patternManager.compilePattern(PROGRAM);
    const entryRef = runtime.patternManager.getArtifactEntryRef(compiled);
    expect(entryRef).toBeDefined();

    const serialized = JSON.parse(JSON.stringify(compiled));

    expect(serialized.$patternRef).toEqual({
      identity: entryRef!.identity,
      symbol: entryRef!.symbol,
    });
    // Schemas ride along so consumers (e.g. llm-dialog tool schemas) can read
    // them without resolving the ref.
    expect(serialized.argumentSchema).toBeDefined();
    expect(serialized.resultSchema).toBeDefined();
    // The graph stays internal.
    expect("nodes" in serialized).toBe(false);
    expect("result" in serialized).toBe(false);
    expect("program" in serialized).toBe(false);
  });

  it("$patternRef is content-derived: two compiles of identical bytes emit the same ref", async () => {
    const first = JSON.parse(
      JSON.stringify(await runtime.patternManager.compilePattern(PROGRAM)),
    );
    const second = JSON.parse(
      JSON.stringify(
        await runtime.patternManager.compilePattern({ ...PROGRAM }),
      ),
    );
    expect(first.$patternRef).toBeDefined();
    expect(first.$patternRef).toEqual(second.$patternRef);
  });

  it("a pattern with no entry ref still serializes its full graph", () => {
    // Manually constructed / dynamic patterns are never indexed; the boundary
    // must keep them loadable, so they fall back to the graph form.
    const fake = {
      argumentSchema: true,
      resultSchema: true,
      result: {},
      nodes: [],
    } as unknown as Pattern;
    const serialized = patternToJSON(fake);
    expect("$patternRef" in serialized).toBe(false);
    expect(Array.isArray((serialized as { nodes: unknown }).nodes)).toBe(true);
  });

  it("internal graph serialization stays the full bare graph", async () => {
    const compiled = await runtime.patternManager.compilePattern(PROGRAM);
    expect(runtime.patternManager.getArtifactEntryRef(compiled)).toBeDefined();

    const internal = serializePatternGraph(compiled as unknown as Pattern);
    expect("$patternRef" in internal).toBe(false);
    expect(Array.isArray((internal as { nodes: unknown }).nodes)).toBe(true);

    const viaLegacyAliases = toJSONWithLegacyAliases(
      compiled as unknown as FactoryInput<unknown>,
    ) as Record<string, unknown>;
    expect("$patternRef" in viaLegacyAliases).toBe(false);
    expect(Array.isArray(viaLegacyAliases.nodes)).toBe(true);
  });

  it("nodes of a freshly compiled pattern embed bare op graphs (no $patternRef)", async () => {
    const compiled = await runtime.patternManager.compilePattern(PROGRAM);
    const json = JSON.stringify((compiled as unknown as Pattern).nodes);
    expect(json.includes("$patternRef")).toBe(false);
  });

  it("a stored refs-only value resolves to the live canonical pattern", async () => {
    const compiled = await runtime.patternManager.compilePattern(PROGRAM);
    const stored = JSON.parse(JSON.stringify(compiled));
    const resolved = resolveStoredPattern(runtime, stored);
    expect(resolved).toBe(compiled);
  });
});

describe("resolveOpPattern", () => {
  it("throws when a ref's module never evaluated in this session", () => {
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

  it("passes a plain stored graph through (no-entry-ref writer)", () => {
    // The stored-keyless remnant path (see stored-pattern-rehydration.test.ts
    // for the end-to-end contract; live keyless ops are minted identities at
    // instantiation instead — CT-1812).
    const graph = { nodes: [], result: {} } as never;
    expect(resolveOpPattern({} as never, graph, "map")).toBe(graph);
  });
});

describe("resolveStoredPattern (stored tool patterns)", () => {
  const refValue = {
    $patternRef: { identity: "cf:module/abc", symbol: "default" },
    argumentSchema: true,
    resultSchema: true,
  } as never;

  it("prefers the live canonical pattern when the identity index hits", () => {
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

  it("yields undefined for an unresolvable refs-only value (async callers load by identity)", () => {
    const fakeRuntime = {
      patternManager: { artifactFromIdentitySync: () => undefined },
    } as never;
    expect(resolveStoredPattern(fakeRuntime, refValue)).toBeUndefined();
  });

  it("passes plain stored graphs and nullish values through", () => {
    const graph = { nodes: [], result: {} };
    expect(resolveStoredPattern({} as never, graph)).toBe(graph);
    expect(resolveStoredPattern({} as never, undefined)).toBeUndefined();
    expect(resolveStoredPattern({} as never, null)).toBeUndefined();
  });

  it("async net: loads an unresolvable refs-only value by identity", async () => {
    const live = { argumentSchema: true } as never;
    let loadedWith: unknown[] = [];
    const fakeRuntime = {
      patternManager: {
        artifactFromIdentitySync: () => undefined,
        loadPatternByIdentity: (
          identity: string,
          symbol: string,
          space: string,
        ) => {
          loadedWith = [identity, symbol, space];
          return Promise.resolve(live);
        },
      },
    } as never;
    const resolved = await resolveStoredPatternAsync(
      fakeRuntime,
      refValue,
      "did:test:space" as never,
    );
    expect(resolved).toBe(live);
    expect(loadedWith).toEqual(["cf:module/abc", "default", "did:test:space"]);
  });

  it("async net: sync hits and plain graphs never reach the loader", async () => {
    const live = { argumentSchema: true } as never;
    const fakeRuntime = {
      patternManager: {
        artifactFromIdentitySync: () => live,
        loadPatternByIdentity: () => {
          throw new Error("must not load");
        },
      },
    } as never;
    expect(
      await resolveStoredPatternAsync(
        fakeRuntime,
        refValue,
        "did:test:space" as never,
      ),
    ).toBe(live);
    const graph = { nodes: [], result: {} };
    expect(
      await resolveStoredPatternAsync(
        fakeRuntime,
        graph,
        "did:test:space" as never,
      ),
    ).toBe(graph);
  });
});
