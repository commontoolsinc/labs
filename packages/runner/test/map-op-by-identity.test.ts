import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import type { Stream, VNode } from "commonfabric";
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

  it("throws when the sentinel misses the session-lifetime index", () => {
    // The artifact index never evicts, and the sentinel is stamped from the
    // op's live artifact in the reading session — a miss is a bug, and the
    // sentinel carries no fallback graph to paper over it (identity E4/E5).
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
      /op pattern cf:module\/miss#s did not evaluate in this session/,
    );
  });

  it("passes a non-sentinel value through unchanged (legacy graph)", () => {
    const graph = { nodes: [], result: {} } as never;
    const resolved = resolveOpPattern({} as never, graph, "map");
    expect(resolved).toBe(graph);
  });
});

// End-to-end: the `op` pattern of a `.map` node is
// passed by its content-addressed `{ identity, symbol }` reference (a
// `{ $patternRef }` sentinel) and resolved synchronously at runtime via
// `artifactFromIdentitySync`, instead of being deserialized from an embedded
// pattern graph.
describe("map op passed by identity", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
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

  it("fails loudly (no fallback output) when the sentinel cannot resolve", async () => {
    const compiled = await runtime.patternManager.compilePattern(PROGRAM);

    // The artifact index is session-lifetime (identity E4), so a genuine miss
    // means the op's module never evaluated in this session — a bug, not an
    // eviction. The sentinel carries NO embedded fallback graph anymore: the
    // map must fail loudly instead of silently running a stale graph.
    const pm = runtime.patternManager;
    let identityMisses = 0;
    pm.artifactFromIdentitySync = () => {
      identityMisses++;
      return undefined;
    };

    const resultCell = runtime.getCell<{ vs: number[] }>(
      space,
      "map op miss is loud",
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

    // The lookups missed and no fallback graph exists: no mapped output.
    expect(identityMisses).toBeGreaterThan(0);
    expect(result.key("vs").get()).not.toEqual([4, 5, 6]);
    cancelSink();
  });

  it("reloads a hoisted op by identity without recompiling", async () => {
    // A map's sub-pattern result cells carry the op's `{ identity, symbol }`,
    // where `symbol` is a HOIST (`__cfPattern_1`), not a module export. On reload
    // the by-identity path must resolve it from the in-memory artifact index — a
    // cold source recompile here is the CT-1623 "compiles=0 reload" regression
    // the shell piece test guards. (Without the fix this resolves to undefined /
    // recompiles, because hoists aren't in `modulesByIdentity.exports`.)
    const compiled = await runtime.patternManager.compilePattern(PROGRAM);
    const pm = runtime.patternManager;
    const entryRef = pm.getArtifactEntryRef(compiled);
    expect(entryRef).toBeDefined();
    const missesBefore = pm.getCompileCacheStats().misses;

    const op = await pm.loadPatternByIdentity(
      entryRef!.identity,
      "__cfPattern_1",
      space,
    );

    expect(op).toBeDefined();
    // Resolved from the live in-memory index — no cold recompile.
    expect(pm.getCompileCacheStats().misses).toBe(missesBefore);
  });

  it("refreshes existing mapped rows when captured params change", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "import { handler, pattern, type Stream, Writable } from 'commonfabric';",
            "interface Item { v: string; }",
            "interface SetViewerEvent { viewer: string; }",
            "interface Output { labels: string[]; setViewer: Stream<SetViewerEvent>; }",
            "const setViewer = handler<SetViewerEvent, { viewer: Writable<string> }>((event, { viewer }) => {",
            "  viewer.set(event.viewer);",
            "});",
            "const Child = pattern<{ item: Item; viewer: string }, { label: string }>(({ item, viewer }) => {",
            "  return { label: viewer === '' ? 'hidden' : `${viewer}:${item.v}` };",
            "});",
            "export default pattern<{ items: Item[] }, Output>(({ items }) => {",
            "  const viewer = new Writable<string>('');",
            "  return {",
            "    labels: items.map((item) => {",
            "      const child = Child({ item, viewer });",
            "      return child.label;",
            "    }),",
            "    setViewer: setViewer({ viewer }),",
            "  };",
            "});",
          ].join("\n"),
        },
      ],
    };
    const compiled = await runtime.patternManager.compilePattern(program);

    interface SetViewerEvent {
      viewer: string;
    }
    const resultCell = runtime.getCell<{
      labels: string[];
      setViewer: Stream<SetViewerEvent>;
    }>(
      space,
      "map params refresh rows",
      compiled.resultSchema,
      tx,
    );
    const result = runtime.run(
      tx,
      compiled,
      { items: [{ v: "a" }, { v: "b" }] },
      resultCell,
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    tx = runtime.edit();
    const cancelSink = result.sink(() => {});
    await runtime.idle();

    expect(await result.key("labels").pull()).toEqual(["hidden", "hidden"]);

    result.key("setViewer").send({ viewer: "Bob" });
    await runtime.idle();

    expect(await result.key("labels").pull()).toEqual(["Bob:a", "Bob:b"]);
    cancelSink();
  });

  it("refreshes existing filtered rows when captured params change", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "import { handler, pattern, type Stream, Writable } from 'commonfabric';",
            "interface Item { v: string; }",
            "interface SetViewerEvent { viewer: string; }",
            "interface Output { labels: string[]; setViewer: Stream<SetViewerEvent>; }",
            "const setViewer = handler<SetViewerEvent, { viewer: Writable<string> }>((event, { viewer }) => {",
            "  viewer.set(event.viewer);",
            "});",
            "const Identity = pattern<{ viewer: string }, { me: string }>(({ viewer }) => ({ me: viewer }));",
            "export default pattern<{ items: Item[] }, Output>(({ items }) => {",
            "  const viewer = new Writable<string>('');",
            "  const identity = Identity({ viewer });",
            "  return {",
            "    labels: items.filter((item) => item.v === identity.me).map((item) => item.v),",
            "    setViewer: setViewer({ viewer }),",
            "  };",
            "});",
          ].join("\n"),
        },
      ],
    };
    const compiled = await runtime.patternManager.compilePattern(program);

    interface SetViewerEvent {
      viewer: string;
    }
    const resultCell = runtime.getCell<{
      labels: string[];
      setViewer: Stream<SetViewerEvent>;
    }>(
      space,
      "filter params refresh rows",
      compiled.resultSchema,
      tx,
    );
    const result = runtime.run(
      tx,
      compiled,
      { items: [{ v: "a" }, { v: "b" }] },
      resultCell,
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    tx = runtime.edit();
    const cancelSink = result.sink(() => {});
    await runtime.idle();

    expect(await result.key("labels").pull()).toEqual([]);

    result.key("setViewer").send({ viewer: "b" });
    await runtime.idle();

    expect(await result.key("labels").pull()).toEqual(["b"]);
    cancelSink();
  });

  it("refreshes existing flatMapped rows when captured params change", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "import { handler, pattern, type Stream, Writable } from 'commonfabric';",
            "interface Item { v: string; }",
            "interface SetViewerEvent { viewer: string; }",
            "interface Output { labels: string[]; setViewer: Stream<SetViewerEvent>; }",
            "const setViewer = handler<SetViewerEvent, { viewer: Writable<string> }>((event, { viewer }) => {",
            "  viewer.set(event.viewer);",
            "});",
            "const Identity = pattern<{ viewer: string }, { me: string }>(({ viewer }) => ({ me: viewer }));",
            "export default pattern<{ items: Item[] }, Output>(({ items }) => {",
            "  const viewer = new Writable<string>('');",
            "  const identity = Identity({ viewer });",
            "  return {",
            "    labels: items.flatMap((item) => identity.me === '' ? [] : [`${identity.me}:${item.v}`]),",
            "    setViewer: setViewer({ viewer }),",
            "  };",
            "});",
          ].join("\n"),
        },
      ],
    };
    const compiled = await runtime.patternManager.compilePattern(program);

    interface SetViewerEvent {
      viewer: string;
    }
    const resultCell = runtime.getCell<{
      labels: string[];
      setViewer: Stream<SetViewerEvent>;
    }>(
      space,
      "flatmap params refresh rows",
      compiled.resultSchema,
      tx,
    );
    const result = runtime.run(
      tx,
      compiled,
      { items: [{ v: "a" }, { v: "b" }] },
      resultCell,
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    tx = runtime.edit();
    const cancelSink = result.sink(() => {});
    await runtime.idle();

    expect(await result.key("labels").pull()).toEqual([]);

    result.key("setViewer").send({ viewer: "Bob" });
    await runtime.idle();

    expect(await result.key("labels").pull()).toEqual(["Bob:a", "Bob:b"]);
    cancelSink();
  });

  it("refreshes existing mapped child conditional UI when captured params change", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "import { handler, pattern, type Stream, UI, type VNode, Writable } from 'commonfabric';",
            "interface Item { v: string; }",
            "interface SetViewerEvent { viewer: string; }",
            "interface Output { rows: VNode[]; setViewer: Stream<SetViewerEvent>; }",
            "const setViewer = handler<SetViewerEvent, { viewer: Writable<string> }>((event, { viewer }) => {",
            "  viewer.set(event.viewer);",
            "});",
            "const Child = pattern<{ item: Item; viewer: string }, { [UI]: VNode }>(({ item, viewer }) => {",
            "  return {",
            "    [UI]: (",
            "      <div data-row={item.v}>",
            "        {viewer === '' ? null : <button data-control={item.v}>Vote</button>}",
            "      </div>",
            "    ),",
            "  };",
            "});",
            "export default pattern<{ items: Item[] }, Output>(({ items }) => {",
            "  const viewer = new Writable<string>('');",
            "  return {",
            "    rows: items.map((item) => {",
            "      const child = Child({ item, viewer });",
            "      return child[UI];",
            "    }),",
            "    setViewer: setViewer({ viewer }),",
            "  };",
            "});",
          ].join("\n"),
        },
      ],
    };
    const compiled = await runtime.patternManager.compilePattern(program);

    interface SetViewerEvent {
      viewer: string;
    }
    const resultCell = runtime.getCell<{
      rows: VNode[];
      setViewer: Stream<SetViewerEvent>;
    }>(
      space,
      "map params refresh conditional ui",
      compiled.resultSchema,
      tx,
    );
    const result = runtime.run(
      tx,
      compiled,
      { items: [{ v: "a" }, { v: "b" }] },
      resultCell,
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    tx = runtime.edit();
    const cancelSink = result.sink(() => {});
    await runtime.idle();

    expect(controlCount(await result.key("rows").pull())).toBe(0);

    result.key("setViewer").send({ viewer: "Bob" });
    await runtime.idle();

    expect(controlCount(await result.key("rows").pull())).toBe(2);
    cancelSink();
  });

  it("refreshes existing mapped child UI when captured params are subpattern outputs", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "import { handler, pattern, type Stream, UI, type VNode, Writable } from 'commonfabric';",
            "interface Item { v: string; }",
            "interface SetViewerEvent { viewer: string; }",
            "interface Output { rows: VNode[]; setViewer: Stream<SetViewerEvent>; }",
            "const setViewer = handler<SetViewerEvent, { viewer: Writable<string> }>((event, { viewer }) => {",
            "  viewer.set(event.viewer);",
            "});",
            "const Identity = pattern<{ viewer: string }, { me: string }>(({ viewer }) => {",
            "  return { me: viewer };",
            "});",
            "const Child = pattern<{ item: Item; viewer: string }, { [UI]: VNode }>(({ item, viewer }) => {",
            "  return {",
            "    [UI]: (",
            "      <div data-row={item.v}>",
            "        {viewer ? <button data-control={item.v}>Vote</button> : null}",
            "      </div>",
            "    ),",
            "  };",
            "});",
            "export default pattern<{ items: Item[] }, Output>(({ items }) => {",
            "  const viewer = new Writable<string>('');",
            "  const identity = Identity({ viewer });",
            "  return {",
            "    rows: items.map((item) => {",
            "      const child = Child({ item, viewer: identity.me });",
            "      return child[UI];",
            "    }),",
            "    setViewer: setViewer({ viewer }),",
            "  };",
            "});",
          ].join("\n"),
        },
      ],
    };
    const compiled = await runtime.patternManager.compilePattern(program);

    interface SetViewerEvent {
      viewer: string;
    }
    const resultCell = runtime.getCell<{
      rows: VNode[];
      setViewer: Stream<SetViewerEvent>;
    }>(
      space,
      "map params refresh subpattern output ui",
      compiled.resultSchema,
      tx,
    );
    const result = runtime.run(
      tx,
      compiled,
      { items: [{ v: "a" }, { v: "b" }] },
      resultCell,
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    tx = runtime.edit();
    const cancelSink = result.sink(() => {});
    await runtime.idle();

    expect(controlCount(await result.key("rows").pull())).toBe(0);

    result.key("setViewer").send({ viewer: "Bob" });
    await runtime.idle();

    expect(controlCount(await result.key("rows").pull())).toBe(2);
    cancelSink();
  });

  it("refreshes mapped child UI when subpattern output comes from PerUser input", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "import { Default, pattern, type PerUser, UI, type VNode } from 'commonfabric';",
            "interface Item { v: string; }",
            "interface Input { items: Item[]; myName?: PerUser<string | Default<''>>; }",
            "interface Output { rows: VNode[]; myName: string; }",
            "const Identity = pattern<{ myName?: PerUser<string | Default<''>> }, { me: string }>(({ myName }) => {",
            "  return { me: myName };",
            "});",
            "const Child = pattern<{ item: Item; viewer: string }, { [UI]: VNode }>(({ item, viewer }) => {",
            "  return {",
            "    [UI]: (",
            "      <div data-row={item.v}>",
            "        {viewer ? <button data-control={item.v}>Vote</button> : null}",
            "      </div>",
            "    ),",
            "  };",
            "});",
            "export default pattern<Input, Output>(({ items, myName }) => {",
            "  const identity = Identity({ myName });",
            "  return {",
            "    myName,",
            "    rows: items.map((item) => {",
            "      const child = Child({ item, viewer: identity.me });",
            "      return child[UI];",
            "    }),",
            "  };",
            "});",
          ].join("\n"),
        },
      ],
    };
    const compiled = await runtime.patternManager.compilePattern(program);

    const resultCell = runtime.getCell<{
      rows: VNode[];
      myName: string;
    }>(
      space,
      "map params refresh per-user subpattern output ui",
      compiled.resultSchema,
      tx,
    );
    const result = runtime.run(
      tx,
      compiled,
      { items: [{ v: "a" }, { v: "b" }] },
      resultCell,
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    tx = runtime.edit();
    const cancelSink = result.sink(() => {});
    await runtime.idle();

    expect(controlCount(await result.key("rows").pull())).toBe(0);

    result.withTx(tx).key("myName").asSchema<string>({
      type: "string",
      scope: "user",
    }).set("Bob");
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    tx = runtime.edit();
    await runtime.idle();

    expect(controlCount(await result.key("rows").pull())).toBe(2);
    cancelSink();
  });

  it("refreshes imported mapped child conditionals from scoped subpattern output", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "import { Default, pattern, type PerUser, UI, type VNode } from 'commonfabric';",
            "import Child from './child.tsx';",
            "interface Item { v: string; }",
            "interface Input { items: Item[]; myName?: PerUser<string | Default<''>>; }",
            "interface Output { rows: VNode[]; myName: string; }",
            "const Identity = pattern<{ myName?: PerUser<string | Default<''>> }, { me: string }>(({ myName }) => {",
            "  return { me: myName };",
            "});",
            "export default pattern<Input, Output>(({ items, myName }) => {",
            "  const identity = Identity({ myName });",
            "  return {",
            "    myName,",
            "    rows: items.map((item) => {",
            "      const child = Child({ item, viewer: identity.me });",
            "      return child[UI];",
            "    }),",
            "  };",
            "});",
          ].join("\n"),
        },
        {
          name: "/child.tsx",
          contents: [
            "import { computed, pattern, UI, type VNode } from 'commonfabric';",
            "interface Item { v: string; }",
            "export default pattern<{ item: Item; viewer: string }, { [UI]: VNode }>(({ item, viewer }) => {",
            "  const isJoined = computed(() => viewer !== '');",
            "  return {",
            "    [UI]: (",
            "      <div data-row={item.v} data-viewer={viewer} data-joined={isJoined ? 'true' : 'false'}>",
            "        {isJoined ? <button data-control={item.v}>Vote</button> : null}",
            "      </div>",
            "    ),",
            "  };",
            "});",
          ].join("\n"),
        },
      ],
    };
    const compiled = await runtime.patternManager.compilePattern(program);

    const resultCell = runtime.getCell<{
      rows: VNode[];
      myName: string;
    }>(
      space,
      "map params refresh imported per-user child conditional",
      compiled.resultSchema,
      tx,
    );
    const result = runtime.run(
      tx,
      compiled,
      { items: [{ v: "a" }, { v: "b" }] },
      resultCell,
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    tx = runtime.edit();
    const cancelSink = result.sink(() => {});
    await runtime.idle();

    expect(controlCount(await result.key("rows").pull())).toBe(0);

    result.withTx(tx).key("myName").asSchema<string>({
      type: "string",
      scope: "user",
    }).set("Bob");
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    tx = runtime.edit();
    await runtime.idle();

    expect(controlCount(await result.key("rows").pull())).toBe(2);
    cancelSink();
  });

  it("initializes appended mapped child UI from scoped subpattern output", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "import { Default, handler, pattern, type PerUser, type Stream, UI, type VNode, Writable } from 'commonfabric';",
            "interface Item { v: string; }",
            "interface AddItemEvent { v: string; }",
            "interface Input { myName?: PerUser<string | Default<''>>; }",
            "interface Output { rows: VNode[]; myName: string; addItem: Stream<AddItemEvent>; }",
            "const addItem = handler<AddItemEvent, { items: Writable<Item[]> }>((event, { items }) => {",
            "  items.push({ v: event.v });",
            "});",
            "const Identity = pattern<{ myName?: PerUser<string | Default<''>> }, { me: string }>(({ myName }) => {",
            "  return { me: myName };",
            "});",
            "const Child = pattern<{ item: Item; viewer: string }, { [UI]: VNode }>(({ item, viewer }) => {",
            "  return {",
            "    [UI]: (",
            "      <div data-row={item.v}>",
            "        {viewer ? <button data-control={item.v}>Vote</button> : null}",
            "      </div>",
            "    ),",
            "  };",
            "});",
            "export default pattern<Input, Output>(({ myName }) => {",
            "  const items = new Writable<Item[]>([{ v: 'a' }]);",
            "  const identity = Identity({ myName });",
            "  return {",
            "    myName,",
            "    rows: items.map((item) => {",
            "      const child = Child({ item, viewer: identity.me });",
            "      return child[UI];",
            "    }),",
            "    addItem: addItem({ items }),",
            "  };",
            "});",
          ].join("\n"),
        },
      ],
    };
    const compiled = await runtime.patternManager.compilePattern(program);

    interface AddItemEvent {
      v: string;
    }
    const resultCell = runtime.getCell<{
      rows: VNode[];
      myName: string;
      addItem: Stream<AddItemEvent>;
    }>(
      space,
      "map appended per-user subpattern output ui",
      compiled.resultSchema,
      tx,
    );
    const result = runtime.run(
      tx,
      compiled,
      {},
      resultCell,
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    tx = runtime.edit();
    const cancelSink = result.sink(() => {});
    await runtime.idle();

    expect(controlCount(await result.key("rows").pull())).toBe(0);

    result.withTx(tx).key("myName").asSchema<string>({
      type: "string",
      scope: "user",
    }).set("Bob");
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    tx = runtime.edit();
    await runtime.idle();

    expect(controlCount(await result.key("rows").pull())).toBe(1);

    result.key("addItem").send({ v: "b" });
    await runtime.idle();

    expect(controlCount(await result.key("rows").pull())).toBe(2);
    cancelSink();
  });

  it("initializes appended mapped child UI from scoped computed subpattern output", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "import { computed, Default, handler, pattern, type PerUser, type Stream, UI, type VNode, Writable } from 'commonfabric';",
            "interface Item { v: string; }",
            "interface AddItemEvent { v: string; }",
            "interface Input { myName?: PerUser<string | Default<''>>; }",
            "interface Output { rows: VNode[]; myName: string; addItem: Stream<AddItemEvent>; }",
            "const addItem = handler<AddItemEvent, { items: Writable<Item[]> }>((event, { items }) => {",
            "  items.push({ v: event.v });",
            "});",
            "const Identity = pattern<{ myName?: PerUser<string | Default<''>> }, { me: string; isJoined: boolean }>(({ myName }) => {",
            "  const me = computed(() => (myName ?? '').trim());",
            "  const isJoined = computed(() => me !== '');",
            "  return { me, isJoined };",
            "});",
            "const Child = pattern<{ item: Item; isJoined: boolean }, { [UI]: VNode }>(({ item, isJoined }) => {",
            "  return {",
            "    [UI]: (",
            "      <div data-row={item.v}>",
            "        {isJoined ? <button data-control={item.v}>Vote</button> : null}",
            "      </div>",
            "    ),",
            "  };",
            "});",
            "export default pattern<Input, Output>(({ myName }) => {",
            "  const items = new Writable<Item[]>([{ v: 'a' }]);",
            "  const identity = Identity({ myName });",
            "  return {",
            "    myName,",
            "    rows: items.map((item) => {",
            "      const child = Child({ item, isJoined: identity.isJoined });",
            "      return child[UI];",
            "    }),",
            "    addItem: addItem({ items }),",
            "  };",
            "});",
          ].join("\n"),
        },
      ],
    };
    const compiled = await runtime.patternManager.compilePattern(program);

    interface AddItemEvent {
      v: string;
    }
    const resultCell = runtime.getCell<{
      rows: VNode[];
      myName: string;
      addItem: Stream<AddItemEvent>;
    }>(
      space,
      "map appended per-user computed output ui",
      compiled.resultSchema,
      tx,
    );
    const result = runtime.run(
      tx,
      compiled,
      {},
      resultCell,
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    tx = runtime.edit();
    const cancelSink = result.sink(() => {});
    await runtime.idle();

    expect(controlCount(await result.key("rows").pull())).toBe(0);

    result.withTx(tx).key("myName").asSchema<string>({
      type: "string",
      scope: "user",
    }).set("Bob");
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    tx = runtime.edit();
    await runtime.idle();

    expect(controlCount(await result.key("rows").pull())).toBe(1);

    result.key("addItem").send({ v: "b" });
    await runtime.idle();

    expect(controlCount(await result.key("rows").pull())).toBe(2);
    cancelSink();
  });

  it("initializes appended root-list mapped child UI from scoped computed subpattern output", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "import { computed, Default, handler, pattern, type PerSpace, type PerUser, type Stream, UI, type VNode, Writable } from 'commonfabric';",
            "interface Item { v: string; }",
            "interface AddItemEvent { v: string; }",
            "interface Input { items?: PerSpace<Item[] | Default<[]>>; myName?: PerUser<string | Default<''>>; }",
            "interface Output { rows: VNode[]; myName: string; addItem: Stream<AddItemEvent>; }",
            "const addItem = handler<AddItemEvent, { items: Writable<Item[] | Default<[]>> }>((event, { items }) => {",
            "  items.push({ v: event.v });",
            "});",
            "const Identity = pattern<{ myName?: PerUser<string | Default<''>> }, { me: string; isJoined: boolean }>(({ myName }) => {",
            "  const me = computed(() => (myName ?? '').trim());",
            "  const isJoined = computed(() => me !== '');",
            "  return { me, isJoined };",
            "});",
            "const Child = pattern<{ item: Item; viewer: string; isJoined: boolean }, { [UI]: VNode }>(({ item, viewer, isJoined }) => {",
            "  return {",
            "    [UI]: (",
            "      <div data-row={item.v} data-viewer={viewer} data-joined={isJoined ? 'true' : 'false'}>",
            "        {isJoined ? <button data-control={item.v}>Vote</button> : null}",
            "      </div>",
            "    ),",
            "  };",
            "});",
            "export default pattern<Input, Output>(({ items, myName }) => {",
            "  const identity = Identity({ myName });",
            "  return {",
            "    myName,",
            "    rows: items.map((item) => {",
            "      const child = Child({ item, viewer: identity.me, isJoined: identity.isJoined });",
            "      return child[UI];",
            "    }),",
            "    addItem: addItem({ items }),",
            "  };",
            "});",
          ].join("\n"),
        },
      ],
    };
    const compiled = await runtime.patternManager.compilePattern(program);

    interface AddItemEvent {
      v: string;
    }
    const resultCell = runtime.getCell<{
      rows: VNode[];
      myName: string;
      addItem: Stream<AddItemEvent>;
    }>(
      space,
      "map appended root-list per-user computed output ui",
      compiled.resultSchema,
      tx,
    );
    const result = runtime.run(
      tx,
      compiled,
      { items: [{ v: "a" }] },
      resultCell,
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    tx = runtime.edit();
    const cancelSink = result.sink(() => {});
    await runtime.idle();

    expect(controlCount(await result.key("rows").pull())).toBe(0);

    result.withTx(tx).key("myName").asSchema<string>({
      type: "string",
      scope: "user",
    }).set("Bob");
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    tx = runtime.edit();
    await runtime.idle();

    expect(controlCount(await result.key("rows").pull())).toBe(1);

    result.key("addItem").send({ v: "b" });
    await runtime.idle();

    expect(controlCount(await result.key("rows").pull())).toBe(2);
    cancelSink();
  });
});

function controlCount(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((total, child) => total + controlCount(child), 0);
  }
  if (typeof value !== "object" || value === null) return 0;
  const node = value as { props?: Record<string, unknown>; children?: unknown };
  const self = node.props && "data-control" in node.props ? 1 : 0;
  return self + controlCount(node.children);
}
