// cell-bridge.test.ts — Integration tests for CellBridge using fake piece objects
import { assertEquals, assertNotEquals } from "@std/assert";
import { FsTree } from "./tree.ts";
import {
  CellBridge,
  type HandlerTarget,
  type SpaceState,
  type WritePath,
} from "./cell-bridge.ts";
import {
  CFC_COMPAT_XATTR_PREFIX,
  CFC_FAIL_CLOSED_ATOM_CLASS,
  listCfcXattrNames,
} from "./annotations.ts";
import { encodeFuseComponent } from "./path-codec.ts";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const decoder = new TextDecoder();

interface FakeCell {
  schema: Record<string, unknown> | undefined;
  get(): unknown;
  getRaw(): unknown;
  asSchemaFromLinks(): FakeCell;
  key(segment: string): FakeCell;
  sink?: (fn: (v: unknown) => void) => () => void;
  isStream?: () => boolean;
}

function makeCell(
  value: unknown,
  schema: Record<string, unknown> | undefined,
  children: Record<string, FakeCell> = {},
  options: { isStream?: boolean } = {},
): FakeCell {
  return {
    schema,
    get: () => value,
    getRaw: () => value,
    asSchemaFromLinks() {
      return this;
    },
    key(segment: string) {
      return children[segment] ?? makeCell(undefined, undefined);
    },
    sink: () => () => {},
    isStream: options.isStream ? () => true : undefined,
  };
}

/**
 * A FakeCell that supports sink() subscriptions, enabling reactive rename tests.
 */
class SinkableCell {
  _value: unknown;
  _sinks: Array<(v: unknown) => void> = [];
  schema = undefined;
  private root: SinkableCell;
  private path: string[];

  constructor(value: unknown, root?: SinkableCell, path: string[] = []) {
    this._value = value;
    this.root = root ?? this;
    this.path = path;
  }

  get() {
    let current = this.root._value;
    for (const segment of this.path) {
      if (
        typeof current !== "object" || current === null ||
        Array.isArray(current)
      ) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[segment];
    }
    return current;
  }

  getRaw() {
    return this.get();
  }

  set(v: unknown) {
    if (this.root !== this) {
      throw new Error("set() is only supported on the root SinkableCell");
    }
    this._value = v;
    for (const fn of this._sinks) fn(v);
  }

  asSchemaFromLinks(): FakeCell {
    return this as unknown as FakeCell;
  }

  key(segment: string): FakeCell {
    return new SinkableCell(undefined, this.root, [
      ...this.path,
      segment,
    ]) as unknown as FakeCell;
  }

  sink(fn: (v: unknown) => void): () => void {
    if (this.root !== this) {
      return this.root.sink(() => fn(this.get()));
    }
    this._sinks.push(fn);
    return () => {
      this._sinks = this._sinks.filter((s) => s !== fn);
    };
  }
}

function getFileContent(tree: FsTree, parentIno: bigint, name: string): string {
  const ino = tree.lookup(parentIno, name);
  if (ino === undefined) throw new Error(`File "${name}" not found`);
  const node = tree.getNode(ino);
  if (!node || node.kind !== "file") throw new Error(`"${name}" is not a file`);
  return decoder.decode(node.content);
}

/**
 * Build a minimal SpaceState backed by a fake PiecesController.
 * Registers the state in bridge.spaces and bridge.knownSpaces.
 */
function buildTestSpace(
  bridge: CellBridge,
  spaceName: string,
  fakePieces: unknown[],
): SpaceState {
  const tree = bridge.tree;
  const spaceIno = tree.addDir(tree.rootIno, encodeFuseComponent(spaceName));
  const piecesIno = tree.addDir(spaceIno, "pieces");
  const entitiesIno = tree.addDir(spaceIno, "entities");

  const state: SpaceState = {
    manager: null as unknown as SpaceState["manager"],
    pieces: {
      getAllPieces: () => Promise.resolve(fakePieces),
    } as unknown as SpaceState["pieces"],
    spaceIno,
    piecesIno,
    entitiesIno,
    pieceMap: new Map(),
    pieceInos: new Map(),
    pieceControllers: new Map(),
    pieceManifest: new Map(),
    pieceSubs: new Map(),
    did: "did:key:zTest",
    unsubscribes: [],
    usedNames: new Set(),
    srcInos: new Map(),
    srcErrorLogInos: new Map(),
  };

  bridge.spaces.set(spaceName, state);
  bridge.knownSpaces.set(spaceName, state.did);
  return state;
}

type AddPieceToSpace = (
  state: SpaceState,
  piece: unknown,
  spaceName: string,
) => Promise<string>;

type LoadPieceTree = (
  piece: unknown,
  parentIno: bigint,
  name: string,
  spaceName: string,
  existingIno?: bigint,
) => Promise<bigint>;

type UpdateIndexJson = (state: SpaceState) => void;

type UpdatePiecesJson = (state: SpaceState) => void;

type SyncPieceListOnce = (
  state: SpaceState,
  spaceName: string,
) => Promise<void>;

type SubscribePiece = (
  piece: unknown,
  pieceIno: bigint,
  pieceName: string,
  spaceName: string,
  state: unknown,
) => Promise<Array<() => void>>;

type HydratePieceProp = (
  pieceIno: bigint,
  propName: "input" | "result",
) => Promise<boolean>;

type RebuildPieceProp = (args: {
  cell: FakeCell;
  newValue: unknown;
  pieceId: string;
  pieceIno: bigint;
  pieceName: string;
  propName: "input" | "result";
  resolveLink: (value: unknown, depth: number) => string | null;
  spaceName: string;
}) => Promise<void>;

type EnqueuePiecePropRebuild = RebuildPieceProp;

type BuildSourceTree = (
  pieceIno: bigint,
  piece: unknown,
  state: SpaceState,
  pieceName: string,
) => Promise<void>;

type WriteFsFile = (
  writePath: unknown,
  text: string,
) => Promise<boolean>;

// ---------------------------------------------------------------------------
// Group 1: loadPieceTree — initial tree structure
// ---------------------------------------------------------------------------

Deno.test("CellBridge.loadPieceTree creates meta.json with id, name", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");

  const piece = {
    id: "of:entity-123",
    name: () => "My Note",
    getPatternMeta: () => Promise.resolve({}),
    input: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
    result: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
  };

  const pieceIno = await (bridge as unknown as { loadPieceTree: LoadPieceTree })
    .loadPieceTree(piece, tree.rootIno, "My Note", "home");

  const metaIno = tree.lookup(pieceIno, "meta.json");
  assertEquals(metaIno !== undefined, true, "meta.json should exist");

  const meta = JSON.parse(getFileContent(tree, pieceIno, "meta.json"));
  assertEquals(meta.id, "of:entity-123");
  assertEquals(meta.name, "My Note");
});

Deno.test("CellBridge.loadPieceTree creates stable input/result stubs without eager hydration", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");

  const piece = {
    id: "of:entity-456",
    name: () => "Article",
    getPatternMeta: () => Promise.resolve({}),
    input: {
      getCell: () =>
        Promise.resolve(makeCell({ title: "hello" }, {
          type: "object",
          properties: { title: { type: "string" } },
        })),
      get: () => Promise.resolve({ title: "hello" }),
    },
    result: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
  };

  const pieceIno = await (bridge as unknown as { loadPieceTree: LoadPieceTree })
    .loadPieceTree(piece, tree.rootIno, "Article", "home");

  const inputIno = tree.lookup(pieceIno, "input");
  const resultIno = tree.lookup(pieceIno, "result");
  assertEquals(
    inputIno !== undefined,
    true,
    "input/ stub dir should exist before hydration",
  );
  assertEquals(
    resultIno !== undefined,
    true,
    "result/ stub dir should exist before hydration",
  );
  assertEquals(tree.getChildren(inputIno!).length, 0);
  assertEquals(tree.getChildren(resultIno!).length, 0);
});

Deno.test("CellBridge CFC annotations attach to hydrated JSON projections and fail closed without runner labels", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec", {
    cfcAnnotations: true,
    projectionGeneration: "test-generation",
  });
  const state = buildTestSpace(bridge, "home", []);

  const piece = {
    id: "of:entity-cfc",
    name: () => "Annotated Fixture",
    getPatternMeta: () => Promise.resolve({}),
    input: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
    result: {
      getCell: () => Promise.resolve(makeCell({ title: "secret" }, undefined)),
      get: () => Promise.resolve({ title: "secret" }),
    },
  };

  const pieceIno = await (bridge as unknown as { loadPieceTree: LoadPieceTree })
    .loadPieceTree(piece, state.piecesIno, "Annotated Fixture", "home");
  await (bridge as unknown as { hydratePieceProp: HydratePieceProp })
    .hydratePieceProp.call(bridge, pieceIno, "result");

  const resultIno = tree.lookup(pieceIno, "result");
  assertEquals(resultIno !== undefined, true);
  const titleIno = tree.lookup(resultIno!, "title");
  assertEquals(titleIno !== undefined, true);

  const annotation = tree.getCfcAnnotation(titleIno!);
  assertEquals(annotation?.ref, {
    type: "common-fabric-fuse-ref-v1",
    space: state.did,
    entity: "of:entity-cfc",
    rootKind: "pieces",
    cell: "result",
    path: ["title"],
    projection: "value",
    generation: "test-generation",
  });
  assertEquals(
    JSON.stringify(annotation?.contentLabel).includes(
      CFC_FAIL_CLOSED_ATOM_CLASS,
    ),
    true,
  );
  assertEquals(
    listCfcXattrNames(tree, titleIno!, {
      enabled: true,
      namespace: "compat",
    }).includes(`${CFC_COMPAT_XATTR_PREFIX}ref`),
    true,
  );
});

Deno.test("CellBridge derives CFC projection generation for hydrated CFC mounts", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec", {
    cfcAnnotations: true,
  });
  const state = buildTestSpace(bridge, "home", []);

  const makeResultCell = (title: string): FakeCell => {
    const searchToolCell = makeCell(
      {
        pattern: {
          argumentSchema: {
            type: "object",
            properties: { query: { type: "string" } },
          },
        },
        extraParams: { title },
      },
      undefined,
    );
    return makeCell(
      {
        title,
        search: searchToolCell.get(),
      },
      {
        type: "object",
        properties: {
          title: { type: "string" },
          search: { type: "object" },
        },
      },
      { search: searchToolCell },
    );
  };

  const initialResultCell = makeResultCell("one");
  const piece = {
    id: "of:entity-derived-generation",
    name: () => "Derived Generation",
    getPatternMeta: () => Promise.resolve({}),
    input: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
    result: {
      getCell: () => Promise.resolve(initialResultCell),
      get: () => Promise.resolve(initialResultCell.get()),
    },
  };

  const pieceIno = await (bridge as unknown as { loadPieceTree: LoadPieceTree })
    .loadPieceTree(piece, state.piecesIno, "Derived Generation", "home");
  await (bridge as unknown as { hydratePieceProp: HydratePieceProp })
    .hydratePieceProp.call(bridge, pieceIno, "result");

  const resultIno = tree.lookup(pieceIno, "result");
  assertEquals(resultIno !== undefined, true);
  const titleIno = tree.lookup(resultIno!, "title");
  const resultJsonIno = tree.lookup(pieceIno, "result.json");
  const callableIno = tree.lookup(resultIno!, "search.tool");
  assertEquals(titleIno !== undefined, true);
  assertEquals(resultJsonIno !== undefined, true);
  assertEquals(callableIno !== undefined, true);

  const titleAnnotation = tree.getCfcAnnotation(titleIno!);
  const resultJsonAnnotation = tree.getCfcAnnotation(resultJsonIno!);
  const callableAnnotation = tree.getCfcAnnotation(callableIno!);
  assertEquals(titleAnnotation?.generation.startsWith("sha256:"), true);
  assertNotEquals(titleAnnotation?.generation, "unavailable");
  assertEquals(titleAnnotation?.ref.generation, titleAnnotation?.generation);
  assertEquals(resultJsonAnnotation?.generation, titleAnnotation?.generation);
  assertEquals(callableAnnotation?.generation, titleAnnotation?.generation);
  assertEquals(
    callableAnnotation?.callable?.descriptor.generation,
    titleAnnotation?.generation,
  );

  const rebuiltResultCell = makeResultCell("two");
  await (bridge as unknown as { rebuildPieceProp: RebuildPieceProp })
    .rebuildPieceProp.call(bridge, {
      cell: rebuiltResultCell,
      newValue: rebuiltResultCell.get(),
      pieceId: piece.id,
      pieceIno,
      pieceName: "Derived Generation",
      propName: "result",
      resolveLink: () => null,
      spaceName: "home",
    });

  const rebuiltResultIno = tree.lookup(pieceIno, "result");
  const rebuiltTitleIno = tree.lookup(rebuiltResultIno!, "title");
  const rebuiltAnnotation = tree.getCfcAnnotation(rebuiltTitleIno!);
  assertNotEquals(rebuiltAnnotation?.generation, titleAnnotation?.generation);
  assertEquals(
    rebuiltAnnotation?.ref.generation,
    rebuiltAnnotation?.generation,
  );
});

Deno.test("CellBridge finalizes CFC annotations after committed writeback", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec", {
    cfcAnnotations: true,
  });
  const state = buildTestSpace(bridge, "home", []);

  let resultValue: Record<string, unknown> = { title: "one" };
  const resultCell: FakeCell = {
    schema: {
      type: "object",
      properties: { title: { type: "string" } },
    },
    get: () => resultValue,
    getRaw: () => resultValue,
    asSchemaFromLinks() {
      return this;
    },
    key(segment: string) {
      return makeCell(resultValue[segment], undefined);
    },
    sink: () => () => {},
  };
  const piece = {
    id: "of:entity-finalize-generation",
    name: () => "Finalize Generation",
    getPatternMeta: () => Promise.resolve({}),
    input: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
    result: {
      getCell: () => Promise.resolve(resultCell),
      get: () => Promise.resolve(resultValue),
      set: (value: unknown, path?: (string | number)[]) => {
        if (path?.length === 1 && typeof path[0] === "string") {
          resultValue = { ...resultValue, [path[0]]: value };
        } else if (
          typeof value === "object" && value !== null && !Array.isArray(value)
        ) {
          resultValue = value as Record<string, unknown>;
        }
        return Promise.resolve();
      },
    },
  };

  state.pieceControllers.set(
    "Finalize Generation",
    piece as unknown as SpaceState["pieceControllers"] extends
      Map<string, infer T> ? T : never,
  );
  const pieceIno = await (bridge as unknown as { loadPieceTree: LoadPieceTree })
    .loadPieceTree(piece, state.piecesIno, "Finalize Generation", "home");
  state.pieceMap.set("Finalize Generation", piece.id);
  state.pieceInos.set("Finalize Generation", pieceIno);

  await (bridge as unknown as { hydratePieceProp: HydratePieceProp })
    .hydratePieceProp.call(bridge, pieceIno, "result");
  const initialResultIno = tree.lookup(pieceIno, "result")!;
  const initialTitleIno = tree.lookup(initialResultIno, "title")!;
  const initialGeneration = tree.getCfcAnnotation(initialTitleIno)?.generation;

  const titleWritePath: WritePath = {
    spaceName: "home",
    pieceName: "Finalize Generation",
    cell: "result",
    jsonPath: ["title"],
    isJsonFile: false,
    piece: piece as unknown as WritePath["piece"],
  };
  await bridge.writeValue(titleWritePath, "two");
  await bridge.finalizeWritePath(titleWritePath);

  const updatedResultIno = tree.lookup(pieceIno, "result")!;
  const updatedTitleIno = tree.lookup(updatedResultIno, "title")!;
  assertEquals(getFileContent(tree, updatedResultIno, "title"), "two");
  assertNotEquals(
    tree.getCfcAnnotation(updatedTitleIno)?.generation,
    initialGeneration,
  );
  assertEquals(
    tree.getCfcAnnotation(updatedTitleIno)?.ref.generation,
    tree.getCfcAnnotation(updatedTitleIno)?.generation,
  );

  const parentWritePath: WritePath = {
    ...titleWritePath,
    jsonPath: [],
    isJsonFile: true,
  };
  await bridge.writeValue(
    { ...parentWritePath, jsonPath: ["created"] },
    "child",
  );
  await bridge.finalizeWritePath(parentWritePath);

  const finalResultIno = tree.lookup(pieceIno, "result")!;
  const childIno = tree.lookup(finalResultIno, "created");
  assertEquals(childIno !== undefined, true);
  assertEquals(
    tree.getCfcAnnotation(childIno!)?.ref.projection,
    "value",
  );
});

Deno.test("CellBridge finalizes CFC annotations after namespace mutation writeback", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec", {
    cfcAnnotations: true,
  });
  const state = buildTestSpace(bridge, "home", []);

  let resultValue: Record<string, unknown> = {
    file: "remove",
    dir: { child: "x" },
    from: { old: "move" },
    to: { stay: true },
  };
  const getAtPath = (path?: (string | number)[]) => {
    let current: unknown = resultValue;
    for (const segment of path ?? []) {
      if (
        typeof current !== "object" || current === null ||
        Array.isArray(current)
      ) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[String(segment)];
    }
    return current;
  };
  const setAtPath = (value: unknown, path?: (string | number)[]) => {
    if (!path || path.length === 0) {
      resultValue = value as Record<string, unknown>;
      return;
    }
    const next = { ...resultValue };
    let current: Record<string, unknown> = next;
    for (const segment of path.slice(0, -1)) {
      const key = String(segment);
      const child = current[key];
      const cloned = typeof child === "object" && child !== null &&
          !Array.isArray(child)
        ? { ...(child as Record<string, unknown>) }
        : {};
      current[key] = cloned;
      current = cloned;
    }
    current[String(path[path.length - 1])] = value;
    resultValue = next;
  };
  const resultCell: FakeCell = {
    schema: { type: "object" },
    get: () => resultValue,
    getRaw: () => resultValue,
    asSchemaFromLinks() {
      return this;
    },
    key(segment: string) {
      return makeCell(resultValue[segment], undefined);
    },
    sink: () => () => {},
  };
  const piece = {
    id: "of:entity-finalize-namespace",
    name: () => "Finalize Namespace",
    getPatternMeta: () => Promise.resolve({}),
    input: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
    result: {
      getCell: () => Promise.resolve(resultCell),
      get: (path?: (string | number)[]) => Promise.resolve(getAtPath(path)),
      set: (value: unknown, path?: (string | number)[]) => {
        setAtPath(value, path);
        return Promise.resolve();
      },
    },
  };

  state.pieceControllers.set(
    "Finalize Namespace",
    piece as unknown as SpaceState["pieceControllers"] extends
      Map<string, infer T> ? T : never,
  );
  const pieceIno = await (bridge as unknown as { loadPieceTree: LoadPieceTree })
    .loadPieceTree(piece, state.piecesIno, "Finalize Namespace", "home");
  state.pieceMap.set("Finalize Namespace", piece.id);
  state.pieceInos.set("Finalize Namespace", pieceIno);

  await (bridge as unknown as { hydratePieceProp: HydratePieceProp })
    .hydratePieceProp.call(bridge, pieceIno, "result");
  const rootPath: WritePath = {
    spaceName: "home",
    pieceName: "Finalize Namespace",
    cell: "result",
    jsonPath: [],
    isJsonFile: true,
    piece: piece as unknown as WritePath["piece"],
  };

  let resultIno = tree.lookup(pieceIno, "result")!;
  const initialRootGeneration = tree.getCfcAnnotation(resultIno)?.generation;
  await bridge.writeValue(rootPath, {
    dir: { child: "x" },
    from: { old: "move" },
    to: { stay: true },
  });
  await bridge.finalizeWritePath(rootPath);
  resultIno = tree.lookup(pieceIno, "result")!;
  assertEquals(tree.lookup(resultIno, "file"), undefined);
  assertNotEquals(
    tree.getCfcAnnotation(resultIno)?.generation,
    initialRootGeneration,
  );

  const afterUnlinkGeneration = tree.getCfcAnnotation(resultIno)?.generation;
  await bridge.writeValue(rootPath, {
    from: { old: "move" },
    to: { stay: true },
  });
  await bridge.finalizeWritePath(rootPath);
  resultIno = tree.lookup(pieceIno, "result")!;
  assertEquals(tree.lookup(resultIno, "dir"), undefined);
  assertNotEquals(
    tree.getCfcAnnotation(resultIno)?.generation,
    afterUnlinkGeneration,
  );

  const fromIno = tree.lookup(resultIno, "from")!;
  const toIno = tree.lookup(resultIno, "to")!;
  const fromGeneration = tree.getCfcAnnotation(fromIno)?.generation;
  const toGeneration = tree.getCfcAnnotation(toIno)?.generation;
  const toPath: WritePath = {
    ...rootPath,
    jsonPath: ["to", "new"],
    isJsonFile: false,
  };
  const fromPath: WritePath = {
    ...rootPath,
    jsonPath: ["from"],
    isJsonFile: true,
  };
  await bridge.writeValue(toPath, "move");
  await bridge.writeValue(fromPath, {});
  await bridge.finalizeWritePath(toPath);
  await bridge.finalizeWritePath(fromPath);

  resultIno = tree.lookup(pieceIno, "result")!;
  const updatedFromIno = tree.lookup(resultIno, "from")!;
  const updatedToIno = tree.lookup(resultIno, "to")!;
  assertEquals(tree.lookup(updatedFromIno, "old"), undefined);
  assertEquals(getFileContent(tree, updatedToIno, "new"), "move");
  assertNotEquals(
    tree.getCfcAnnotation(updatedFromIno)?.generation,
    fromGeneration,
  );
  assertNotEquals(
    tree.getCfcAnnotation(updatedToIno)?.generation,
    toGeneration,
  );

  const beforeSymlinkGeneration = tree.getCfcAnnotation(resultIno)?.generation;
  await bridge.writeValue(
    { ...rootPath, jsonPath: ["link"], isJsonFile: false },
    { "/": { "link@1": { path: ["to", "new"] } } },
  );
  await bridge.finalizeWritePath(rootPath);
  resultIno = tree.lookup(pieceIno, "result")!;
  const linkIno = tree.lookup(resultIno, "link")!;
  assertEquals(tree.getNode(linkIno)?.kind, "symlink");
  assertEquals(tree.getCfcAnnotation(linkIno)?.ref.projection, "symlink");
  assertNotEquals(
    tree.getCfcAnnotation(resultIno)?.generation,
    beforeSymlinkGeneration,
  );
});

Deno.test("CellBridge.prepareLookup hydrates result.json on direct lookup", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");

  const piece = {
    id: "of:entity-result-json",
    name: () => "Lookup JSON",
    getPatternMeta: () => Promise.resolve({}),
    input: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
    result: {
      getCell: () =>
        Promise.resolve(makeCell({ content: "hello" }, {
          type: "object",
          properties: { content: { type: "string" } },
        })),
      get: () => Promise.resolve({ content: "hello" }),
    },
  };

  const pieceIno = await (bridge as unknown as { loadPieceTree: LoadPieceTree })
    .loadPieceTree(piece, tree.rootIno, "Lookup JSON", "home");

  // result.json exists as a stub placeholder before hydration
  assertEquals(tree.lookup(pieceIno, "result.json") !== undefined, true);

  const prepared = await (bridge as unknown as {
    prepareLookup: (parentIno: bigint, name: string) => Promise<boolean>;
  }).prepareLookup(pieceIno, "result.json");

  assertEquals(prepared, true);
  assertEquals(tree.lookup(pieceIno, "result.json") !== undefined, true);
  assertEquals(
    JSON.parse(getFileContent(tree, pieceIno, "result.json")),
    { content: "hello" },
  );
});

Deno.test("CellBridge.hydratePieceProp renders link-backed handlers only at discovered callable entries", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const state = buildTestSpace(bridge, "home", []);

  const handlerLink = {
    "/": {
      "link@1": {
        path: ["recordMessage"],
        id: "of:handler-target",
        space: "did:key:zTest",
      },
    },
  };
  const nestedValue = { recordMessage: { text: "not callable" } };
  const handlerCell: FakeCell = {
    schema: { type: "object" },
    get: () => handlerLink,
    getRaw: () => ({ $stream: true }),
    asSchemaFromLinks() {
      return this;
    },
    key: () => makeCell(undefined, undefined),
    sink: () => () => {},
    isStream: () => true,
  };
  const resultCell = makeCell(
    { recordMessage: handlerLink, nested: nestedValue },
    {
      type: "object",
      properties: {
        recordMessage: { type: "object" },
        nested: { type: "object" },
      },
    },
    {
      recordMessage: handlerCell,
      nested: makeCell(nestedValue, { type: "object" }),
    },
  );

  const piece = {
    id: "of:entity-link-handler",
    name: () => "Link Handler",
    getPatternMeta: () => Promise.resolve({}),
    input: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
    result: {
      getCell: () => Promise.resolve(resultCell),
      get: () =>
        Promise.resolve({
          recordMessage: handlerLink,
          nested: nestedValue,
        }),
    },
  };

  const pieceIno = await (bridge as unknown as { loadPieceTree: LoadPieceTree })
    .loadPieceTree(piece, state.piecesIno, "Link-Handler", "home");
  const hydrated = await (bridge as unknown as {
    hydratePieceProp: HydratePieceProp;
  }).hydratePieceProp(pieceIno, "result");

  assertEquals(hydrated, true);
  const resultIno = tree.lookup(pieceIno, "result");
  assertEquals(
    tree.lookup(resultIno!, "recordMessage.handler") !== undefined,
    true,
  );

  const resultJson = JSON.parse(getFileContent(tree, pieceIno, "result.json"));
  assertEquals(resultJson.recordMessage, { "/handler": "recordMessage" });
  assertEquals(resultJson.nested.recordMessage, { text: "not callable" });
  assertEquals(
    JSON.parse(getFileContent(tree, resultIno!, "nested.json")).recordMessage,
    { text: "not callable" },
  );
});

Deno.test("CellBridge.hydratePieceProp materializes input and result on demand", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const state = buildTestSpace(bridge, "home", []);

  const piece = {
    id: "of:entity-789",
    name: () => "Post",
    getPatternMeta: () => Promise.resolve({}),
    input: {
      getCell: () =>
        Promise.resolve(makeCell({ title: "hello" }, {
          type: "object",
          properties: { title: { type: "string" } },
        })),
      get: () => Promise.resolve({ title: "hello" }),
    },
    result: {
      getCell: () =>
        Promise.resolve(makeCell({ content: "world" }, {
          type: "object",
          properties: { content: { type: "string" } },
        })),
      get: () => Promise.resolve({ content: "world" }),
    },
  };

  state.pieceControllers.set(
    "Post",
    piece as unknown as SpaceState["pieceControllers"] extends
      Map<string, infer T> ? T : never,
  );
  const pieceIno = await (bridge as unknown as { loadPieceTree: LoadPieceTree })
    .loadPieceTree(piece, state.piecesIno, "Post", "home");
  state.pieceMap.set("Post", piece.id);
  state.pieceInos.set("Post", pieceIno);

  await (bridge as unknown as { hydratePieceProp: HydratePieceProp })
    .hydratePieceProp.call(bridge, pieceIno, "input");
  const inputIno = tree.lookup(pieceIno, "input");
  assertEquals(
    inputIno !== undefined,
    true,
    "input/ dir should exist after hydration",
  );
  assertEquals(getFileContent(tree, inputIno!, "title"), "hello");

  await (bridge as unknown as { hydratePieceProp: HydratePieceProp })
    .hydratePieceProp.call(bridge, pieceIno, "result");
  const resultIno = tree.lookup(pieceIno, "result");
  assertEquals(
    resultIno !== undefined,
    true,
    "result/ dir should exist after hydration",
  );

  const contentValue = getFileContent(tree, resultIno!, "content");
  assertEquals(contentValue, "world");
});

Deno.test("CellBridge.hydratePieceProp returns early when a prop is already hydrated", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const state = buildTestSpace(bridge, "home", []);
  let resultGets = 0;
  let resultCellGets = 0;

  const piece = {
    id: "of:cached-piece",
    name: () => "Cached Piece",
    getPatternMeta: () => Promise.resolve({}),
    input: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
    result: {
      getCell: () => {
        resultCellGets++;
        return Promise.resolve(makeCell({ content: "world" }, {
          type: "object",
          properties: { content: { type: "string" } },
        }));
      },
      get: () => {
        resultGets++;
        return Promise.resolve({ content: "world" });
      },
    },
  };

  const addPiece = (bridge as unknown as { addPieceToSpace: AddPieceToSpace })
    .addPieceToSpace.bind(bridge);
  await addPiece(state, piece, "home");

  const pieceIno = tree.lookup(state.piecesIno, "Cached-Piece")!;
  const initialResultCellGets = resultCellGets;
  const initialResultGets = resultGets;
  await (bridge as unknown as { hydratePieceProp: HydratePieceProp })
    .hydratePieceProp.call(bridge, pieceIno, "result");
  await (bridge as unknown as { hydratePieceProp: HydratePieceProp })
    .hydratePieceProp.call(bridge, pieceIno, "result");

  assertEquals(resultCellGets - initialResultCellGets, 1);
  assertEquals(resultGets - initialResultGets, 1);
  assertEquals(tree.lookup(pieceIno, "result") !== undefined, true);
});

Deno.test("CellBridge.rebuildPieceProp keeps replaced callable inodes alive briefly", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const state = buildTestSpace(bridge, "home", []);

  const initialToolCell = makeCell(
    {
      pattern: {
        argumentSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
      extraParams: { source: "before" },
    },
    undefined,
  );
  const initialResultCell = makeCell(
    {
      title: "before",
      search: initialToolCell.get(),
    },
    {
      type: "object",
      properties: {
        title: { type: "string" },
        search: { type: "object" },
      },
    },
    { search: initialToolCell },
  );

  const piece = {
    id: "of:entity-stale-callable",
    name: () => "Callable Fixture",
    getPatternMeta: () => Promise.resolve({}),
    input: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
    result: {
      getCell: () => Promise.resolve(initialResultCell),
      get: () => Promise.resolve(initialResultCell.get()),
    },
  };

  state.pieceControllers.set(
    "Callable Fixture",
    piece as unknown as SpaceState["pieceControllers"] extends
      Map<string, infer T> ? T : never,
  );
  const pieceIno = await (bridge as unknown as { loadPieceTree: LoadPieceTree })
    .loadPieceTree(piece, state.piecesIno, "Callable Fixture", "home");
  state.pieceMap.set("Callable Fixture", piece.id);
  state.pieceInos.set("Callable Fixture", pieceIno);

  await (bridge as unknown as { hydratePieceProp: HydratePieceProp })
    .hydratePieceProp.call(bridge, pieceIno, "result");

  const initialResultIno = tree.lookup(pieceIno, "result");
  assertEquals(initialResultIno !== undefined, true);
  const initialToolIno = tree.lookup(initialResultIno!, "search.tool");
  assertEquals(initialToolIno !== undefined, true);

  const rebuiltToolCell = makeCell(
    {
      pattern: {
        argumentSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
      extraParams: { source: "after" },
    },
    undefined,
  );
  const rebuiltResultCell = makeCell(
    {
      title: "after",
      search: rebuiltToolCell.get(),
    },
    {
      type: "object",
      properties: {
        title: { type: "string" },
        search: { type: "object" },
      },
    },
    { search: rebuiltToolCell },
  );

  await (bridge as unknown as { rebuildPieceProp: RebuildPieceProp })
    .rebuildPieceProp.call(bridge, {
      cell: rebuiltResultCell,
      newValue: rebuiltResultCell.get(),
      pieceId: piece.id,
      pieceIno,
      pieceName: "Callable Fixture",
      propName: "result",
      resolveLink: () => null,
      spaceName: "home",
    });

  const currentResultIno = tree.lookup(pieceIno, "result");
  assertEquals(currentResultIno !== undefined, true);
  const currentToolIno = tree.lookup(currentResultIno!, "search.tool");
  assertEquals(currentToolIno !== undefined, true);
  assertEquals(currentToolIno === initialToolIno, false);
  assertEquals(tree.getNode(initialToolIno!)?.kind, "callable");
});

Deno.test("CellBridge queues piece prop rebuilds for the same prop", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const cell = makeCell({}, undefined);

  let releaseFirst: (() => void) | undefined;
  const firstCanFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let active = 0;
  let maxActive = 0;
  const events: string[] = [];

  (bridge as unknown as { rebuildPieceProp: RebuildPieceProp })
    .rebuildPieceProp = async (args) => {
      active++;
      maxActive = Math.max(maxActive, active);
      events.push(`start-${String(args.newValue)}`);
      if (args.newValue === "first") {
        await firstCanFinish;
      }
      events.push(`end-${String(args.newValue)}`);
      active--;
    };

  const enqueue = (bridge as unknown as {
    enqueuePiecePropRebuild: EnqueuePiecePropRebuild;
  }).enqueuePiecePropRebuild.bind(bridge);

  const baseJob = {
    cell,
    pieceId: "of:queued-prop",
    pieceIno: 42n,
    pieceName: "Queued Prop",
    propName: "result" as const,
    resolveLink: () => null,
    spaceName: "home",
  };

  const first = enqueue({ ...baseJob, newValue: "first" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = enqueue({ ...baseJob, newValue: "second" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assertEquals(events, ["start-first"]);
  releaseFirst?.();
  await Promise.all([first, second]);

  assertEquals(maxActive, 1);
  assertEquals(events, [
    "start-first",
    "end-first",
    "start-second",
    "end-second",
  ]);
});

Deno.test("CellBridge.rebuildPieceProp clears stale result mounts when value becomes null", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const state = buildTestSpace(bridge, "home", []);

  const initialResultCell = makeCell(
    { title: "before" },
    {
      type: "object",
      properties: {
        title: { type: "string" },
      },
    },
  );

  const piece = {
    id: "of:entity-null-result",
    name: () => "Null Result Fixture",
    getPatternMeta: () => Promise.resolve({}),
    input: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
    result: {
      getCell: () => Promise.resolve(initialResultCell),
      get: () => Promise.resolve(initialResultCell.get()),
    },
  };

  state.pieceControllers.set(
    "Null Result Fixture",
    piece as unknown as SpaceState["pieceControllers"] extends
      Map<string, infer T> ? T : never,
  );
  const pieceIno = await (bridge as unknown as { loadPieceTree: LoadPieceTree })
    .loadPieceTree(piece, state.piecesIno, "Null Result Fixture", "home");
  state.pieceMap.set("Null Result Fixture", piece.id);
  state.pieceInos.set("Null Result Fixture", pieceIno);

  await (bridge as unknown as { hydratePieceProp: HydratePieceProp })
    .hydratePieceProp.call(bridge, pieceIno, "result");

  const initialResultIno = tree.lookup(pieceIno, "result");
  assertEquals(initialResultIno !== undefined, true);
  assertEquals(getFileContent(tree, initialResultIno!, "title"), "before");
  assertEquals(tree.lookup(pieceIno, "result.json") !== undefined, true);

  await (bridge as unknown as { rebuildPieceProp: RebuildPieceProp })
    .rebuildPieceProp.call(bridge, {
      cell: makeCell(null, undefined),
      newValue: null,
      pieceId: piece.id,
      pieceIno,
      pieceName: "Null Result Fixture",
      propName: "result",
      resolveLink: () => null,
      spaceName: "home",
    });

  assertEquals(tree.lookup(pieceIno, "result"), undefined);
  assertEquals(tree.lookup(pieceIno, "result.json"), undefined);
});

Deno.test("CellBridge.rebuildPieceProp clears stale FS projection mounts when value becomes null", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const state = buildTestSpace(bridge, "home", []);

  const initialResultCell = new SinkableCell({
    $FS: {
      type: "text/markdown",
      content: "Hello",
      frontmatter: {
        meta: {
          pinned: true,
        },
      },
    },
  });

  const piece = {
    id: "of:entity-null-fs",
    name: () => "Null FS Fixture",
    getPatternMeta: () => Promise.resolve({}),
    input: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
    result: {
      getCell: () => Promise.resolve(initialResultCell as unknown as FakeCell),
      get: () => Promise.resolve(initialResultCell.get()),
    },
  };

  const addPiece = (bridge as unknown as { addPieceToSpace: AddPieceToSpace })
    .addPieceToSpace.bind(bridge);
  await addPiece(state, piece, "home");

  const pieceIno = tree.lookup(state.piecesIno, "Null-FS-Fixture")!;

  await (bridge as unknown as { hydratePieceProp: HydratePieceProp })
    .hydratePieceProp.call(bridge, pieceIno, "result");

  assertEquals(tree.lookup(pieceIno, "index.md") !== undefined, true);
  assertEquals(tree.lookup(pieceIno, "meta") !== undefined, true);

  await (bridge as unknown as { rebuildPieceProp: RebuildPieceProp })
    .rebuildPieceProp.call(bridge, {
      cell: makeCell(null, undefined),
      newValue: null,
      pieceId: piece.id,
      pieceIno,
      pieceName: "Null FS Fixture",
      propName: "result",
      resolveLink: () => null,
      spaceName: "home",
    });

  assertEquals(tree.lookup(pieceIno, "index.md"), undefined);
  assertEquals(tree.lookup(pieceIno, "index.json"), undefined);
  assertEquals(tree.lookup(pieceIno, "meta"), undefined);
});

Deno.test("CellBridge.hydratePieceProp labels void handlers as no-arg callables in .handlers", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const state = buildTestSpace(bridge, "home", []);

  const onAddContactCell = makeCell(
    { $stream: true },
    { asCell: ["stream"] },
    {},
    { isStream: true },
  );
  const resultCell = makeCell(
    { onAddContact: { $stream: true } },
    {
      type: "object",
      properties: {
        onAddContact: { asCell: ["stream"] },
      },
    },
    { onAddContact: onAddContactCell },
  );

  const piece = {
    id: "of:entity-void-handler",
    name: () => "Contact Book",
    getPatternMeta: () => Promise.resolve({}),
    input: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
    result: {
      getCell: () => Promise.resolve(resultCell),
      get: () => Promise.resolve({ onAddContact: { $stream: true } }),
    },
  };

  state.pieceControllers.set(
    "Contact Book",
    piece as unknown as SpaceState["pieceControllers"] extends
      Map<string, infer T> ? T : never,
  );
  const pieceIno = await (bridge as unknown as { loadPieceTree: LoadPieceTree })
    .loadPieceTree(piece, state.piecesIno, "Contact Book", "home");
  state.pieceMap.set("Contact Book", piece.id);
  state.pieceInos.set("Contact Book", pieceIno);

  await (bridge as unknown as { hydratePieceProp: HydratePieceProp })
    .hydratePieceProp.call(bridge, pieceIno, "result");

  const handlers = getFileContent(tree, pieceIno, ".handlers");
  assertEquals(
    handlers.includes("onAddContact.handler  void (invoke with no args)"),
    true,
  );
});

// ---------------------------------------------------------------------------
// Group 2: addPieceToSpace — name collision
// ---------------------------------------------------------------------------

Deno.test("CellBridge.addPieceToSpace assigns -2 suffix on name collision", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const state = buildTestSpace(bridge, "home", []);

  const makeNotePiece = (id: string) => ({
    id,
    name: () => "My Note",
    getPatternMeta: () => Promise.resolve({}),
    input: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
    result: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
  });

  const addPiece = (bridge as unknown as { addPieceToSpace: AddPieceToSpace })
    .addPieceToSpace.bind(bridge);

  const name1 = await addPiece(state, makeNotePiece("of:id-1"), "home");
  const name2 = await addPiece(state, makeNotePiece("of:id-2"), "home");

  assertEquals(name1, "My-Note");
  assertEquals(name2, "My-Note-2");

  // Both entries should be in pieceMap
  assertEquals(state.pieceMap.has("My-Note"), true);
  assertEquals(state.pieceMap.has("My-Note-2"), true);

  // Both directories should exist in the tree
  assertEquals(tree.lookup(state.piecesIno, "My-Note") !== undefined, true);
  assertEquals(tree.lookup(state.piecesIno, "My-Note-2") !== undefined, true);
});

// Regression: on a cold runtime the piece list doesn't load the linked piece
// docs, so a synchronous piece.name() read returns undefined until the NAME
// doc is synced. addPieceToSpace must await that sync before choosing the
// directory name — otherwise the piece mounts under the opaque id-derived
// fallback name, permanently if no later change event fires (CI fuse-exec
// "Timed out waiting for path: pieces/Fuse-Exec-Fixture").
Deno.test("CellBridge.addPieceToSpace syncs a late-loading name before naming the directory", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const state = buildTestSpace(bridge, "home", []);

  // name() returns undefined until getCell().asSchema(...).sync() resolves —
  // mirroring PieceController.name() reading a doc that loads asynchronously.
  let nameLoaded = false;
  const piece = {
    id: "of:cold-start",
    name: () => (nameLoaded ? "Fuse Exec Fixture" : undefined),
    getCell: () => ({
      asSchema: () => ({
        sync: () => {
          nameLoaded = true;
          return Promise.resolve();
        },
      }),
    }),
    getPatternMeta: () => Promise.resolve({}),
    input: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
    result: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
  };

  const addPiece = (bridge as unknown as { addPieceToSpace: AddPieceToSpace })
    .addPieceToSpace.bind(bridge);
  const name = await addPiece(state, piece, "home");

  assertEquals(name, "Fuse-Exec-Fixture");
  assertEquals(
    tree.lookup(state.piecesIno, "Fuse-Exec-Fixture") !== undefined,
    true,
    "piece dir should use the synced name, not the id fallback",
  );
});

Deno.test("CellBridge.addPieceToSpace assigns -2 and -3 suffixes for three collisions", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const state = buildTestSpace(bridge, "home", []);

  const makeStandupPiece = (id: string) => ({
    id,
    name: () => "Standup",
    getPatternMeta: () => Promise.resolve({}),
    input: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
    result: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
  });

  const addPiece = (bridge as unknown as { addPieceToSpace: AddPieceToSpace })
    .addPieceToSpace.bind(bridge);

  const name1 = await addPiece(state, makeStandupPiece("of:su-1"), "home");
  const name2 = await addPiece(state, makeStandupPiece("of:su-2"), "home");
  const name3 = await addPiece(state, makeStandupPiece("of:su-3"), "home");

  assertEquals(name1, "Standup");
  assertEquals(name2, "Standup-2");
  assertEquals(name3, "Standup-3");

  assertEquals(tree.lookup(state.piecesIno, "Standup") !== undefined, true);
  assertEquals(tree.lookup(state.piecesIno, "Standup-2") !== undefined, true);
  assertEquals(tree.lookup(state.piecesIno, "Standup-3") !== undefined, true);
});

// ---------------------------------------------------------------------------
// Group 3: updateIndexJson
// ---------------------------------------------------------------------------

Deno.test("CellBridge.updateIndexJson writes .index.json mapping names to entity IDs", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const state = buildTestSpace(bridge, "home", []);

  const addPiece = (bridge as unknown as { addPieceToSpace: AddPieceToSpace })
    .addPieceToSpace.bind(bridge);

  await addPiece(
    state,
    {
      id: "of:alpha",
      name: () => "Alpha",
      getPatternMeta: () => Promise.resolve({}),
      input: {
        getCell: () => Promise.resolve(makeCell({}, undefined)),
        get: () => Promise.resolve({}),
      },
      result: {
        getCell: () => Promise.resolve(makeCell({}, undefined)),
        get: () => Promise.resolve({}),
      },
    },
    "home",
  );

  await addPiece(
    state,
    {
      id: "of:beta",
      name: () => "Beta",
      getPatternMeta: () => Promise.resolve({}),
      input: {
        getCell: () => Promise.resolve(makeCell({}, undefined)),
        get: () => Promise.resolve({}),
      },
      result: {
        getCell: () => Promise.resolve(makeCell({}, undefined)),
        get: () => Promise.resolve({}),
      },
    },
    "home",
  );

  (bridge as unknown as { updateIndexJson: UpdateIndexJson }).updateIndexJson
    .call(bridge, state);

  const indexJson = JSON.parse(
    getFileContent(tree, state.piecesIno, ".index.json"),
  );

  assertEquals(indexJson["Alpha"], "of:alpha");
  assertEquals(indexJson["Beta"], "of:beta");
});

Deno.test("CellBridge.updatePiecesJson writes cached manifest data without piece reads", () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const state = buildTestSpace(bridge, "home", []);

  state.pieceMap.set("Alpha", "of:alpha");
  state.pieceMap.set("Beta", "of:beta");
  state.pieceManifest.set("of:alpha", {
    summary: "alpha summary",
  });
  state.pieceManifest.set("of:beta", {
    summary: "beta summary",
  });

  (bridge as unknown as { updatePiecesJson: UpdatePiecesJson }).updatePiecesJson
    .call(bridge, state);

  const piecesJson = JSON.parse(
    getFileContent(tree, state.piecesIno, "pieces.json"),
  );
  assertEquals(piecesJson, [
    {
      id: "of:alpha",
      name: "Alpha",
      summary: "alpha summary",
      entityPath: "entities/of%3Aalpha",
    },
    {
      id: "of:beta",
      name: "Beta",
      summary: "beta summary",
      entityPath: "entities/of%3Abeta",
    },
  ]);
});

Deno.test("CellBridge result hydration updates pieces.json summary from current result data", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const state = buildTestSpace(bridge, "home", []);
  const resultCell = new SinkableCell({ summary: "before" });

  const piece = {
    id: "of:summary-piece",
    name: () => "Summary Piece",
    getPatternMeta: () => Promise.resolve({}),
    input: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
    result: {
      getCell: () => Promise.resolve(resultCell as unknown as FakeCell),
      get: () => Promise.resolve(resultCell.get()),
    },
  };

  const addPiece = (bridge as unknown as { addPieceToSpace: AddPieceToSpace })
    .addPieceToSpace.bind(bridge);
  await addPiece(state, piece, "home");

  (bridge as unknown as { updatePiecesJson: UpdatePiecesJson }).updatePiecesJson
    .call(bridge, state);
  let piecesJson = JSON.parse(
    getFileContent(tree, state.piecesIno, "pieces.json"),
  );
  assertEquals(piecesJson[0].summary, "before");

  resultCell.set({ summary: "after" });
  // Wait for debounce (150ms) + rebuild
  await new Promise((resolve) => setTimeout(resolve, 250));

  piecesJson = JSON.parse(getFileContent(tree, state.piecesIno, "pieces.json"));
  assertEquals(piecesJson[0].summary, "after");

  // Cancel subscriptions to avoid timer leaks
  const subs = state.pieceSubs.get("Summary-Piece");
  if (subs) { for (const cancel of subs) cancel(); }
});

Deno.test("CellBridge.writeFsFile writes markdown frontmatter and body to FS paths", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const writes: Array<{ path: (string | number)[]; value: unknown }> = [];

  const ok = await (bridge as unknown as { writeFsFile: WriteFsFile })
    .writeFsFile(
      {
        fsProjection: "markdown",
        piece: {
          result: {
            set: (
              value: unknown,
              path?: (string | number)[],
            ) => {
              writes.push({ path: path ?? [], value });
              return Promise.resolve();
            },
          },
        },
      },
      "---\ntitle: Updated Title\n---\n\nUpdated body",
    );

  assertEquals(ok, true);
  assertEquals(writes, [
    { path: ["$FS", "frontmatter", "title"], value: "Updated Title" },
    { path: ["$FS", "content"], value: "Updated body" },
  ]);
});

Deno.test("CellBridge.writeFsFile removes deleted markdown frontmatter keys and preserves scalar types", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const writes: Array<{ path: (string | number)[]; value: unknown }> = [];

  const ok = await (bridge as unknown as { writeFsFile: WriteFsFile })
    .writeFsFile(
      {
        fsProjection: "markdown",
        piece: {
          result: {
            get: (path?: (string | number)[]) => {
              if (path?.join("/") === "$FS/frontmatter") {
                return Promise.resolve({
                  title: "Old Title",
                  stale: true,
                });
              }
              return Promise.resolve(undefined);
            },
            set: (
              value: unknown,
              path?: (string | number)[],
            ) => {
              writes.push({ path: path ?? [], value });
              return Promise.resolve();
            },
          },
        },
      },
      "---\ntitle: Updated Title\ncount: 42\npublished: true\n---\n\nUpdated body",
    );

  assertEquals(ok, true);
  assertEquals(writes, [
    { path: ["$FS", "frontmatter", "title"], value: "Updated Title" },
    { path: ["$FS", "frontmatter", "count"], value: 42 },
    { path: ["$FS", "frontmatter", "published"], value: true },
    { path: ["$FS", "frontmatter", "stale"], value: undefined },
    { path: ["$FS", "content"], value: "Updated body" },
  ]);
});

Deno.test("CellBridge.writeFsFile removes deleted keys from application/json projections", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const writes: Array<{ path: (string | number)[]; value: unknown }> = [];

  const ok = await (bridge as unknown as { writeFsFile: WriteFsFile })
    .writeFsFile(
      {
        fsProjection: "json",
        piece: {
          result: {
            get: (path?: (string | number)[]) => {
              if (path?.join("/") === "$FS") {
                return Promise.resolve({
                  type: "application/json",
                  content: { title: "Old", stale: true },
                });
              }
              if (path?.join("/") === "$FS/content") {
                return Promise.resolve({ title: "Old", stale: true });
              }
              return Promise.resolve(undefined);
            },
            set: (
              value: unknown,
              path?: (string | number)[],
            ) => {
              writes.push({ path: path ?? [], value });
              return Promise.resolve();
            },
          },
        },
      },
      '{"title":"New"}',
    );

  assertEquals(ok, true);
  assertEquals(writes, [
    { path: ["$FS", "content", "title"], value: "New" },
    { path: ["$FS", "content", "stale"], value: undefined },
  ]);
});

Deno.test("CellBridge.buildSourceTree encodes source path segments and decodes write paths", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const state = buildTestSpace(bridge, "home", []);
  const pieceIno = tree.addDir(state.piecesIno, "notes");
  const piece = {
    id: "of:source-piece",
    getPatternMeta: () =>
      Promise.resolve({
        program: {
          main: "/src/has:colon.tsx",
          files: [
            { name: "/src/has:colon.tsx", contents: "export default 1;" },
          ],
        },
      }),
  };
  state.pieceControllers.set("notes", piece as never);
  state.srcInos.set("notes", pieceIno);

  await (bridge as unknown as { buildSourceTree: BuildSourceTree })
    .buildSourceTree(pieceIno, piece, state, "notes");

  const srcIno = tree.lookup(pieceIno, ".src")!;
  const srcDirIno = tree.lookup(srcIno, "src")!;
  const sourceIno = tree.lookup(srcDirIno, "has%3Acolon.tsx")!;
  assertEquals(
    bridge.resolveSourceWritePath(sourceIno)?.relPath,
    "src/has:colon.tsx",
  );
});

Deno.test("CellBridge decodes encoded space directory names for write paths", () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const state = buildTestSpace(bridge, "did:key:zSpace", []);
  const piece = {
    id: "of:encoded-space-piece",
    name: () => "Encoded Space Piece",
  };
  state.pieceControllers.set("notes", piece as never);

  const pieceIno = tree.addDir(state.piecesIno, "notes");
  const resultIno = tree.addDir(pieceIno, "result");
  const titleIno = tree.addFile(resultIno, "title", "hello", "string");

  const writePath = bridge.resolveWritePath(titleIno);
  assertEquals(writePath?.spaceName, "did:key:zSpace");
  assertEquals(writePath?.pieceName, "notes");
  assertEquals(writePath?.cell, "result");
  assertEquals(writePath?.jsonPath, ["title"]);
});

Deno.test("CellBridge decodes encoded space directory names for source write paths", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const state = buildTestSpace(bridge, "did:key:zSource", []);
  const pieceIno = tree.addDir(state.piecesIno, "notes");
  const piece = {
    id: "of:encoded-source-piece",
    getPatternMeta: () =>
      Promise.resolve({
        program: {
          main: "/src/main.ts",
          files: [{ name: "/src/main.ts", contents: "export default 1;" }],
        },
      }),
  };
  state.pieceControllers.set("notes", piece as never);
  state.srcInos.set("notes", pieceIno);

  await (bridge as unknown as { buildSourceTree: BuildSourceTree })
    .buildSourceTree(pieceIno, piece, state, "notes");

  const srcIno = tree.lookup(pieceIno, ".src")!;
  const srcDirIno = tree.lookup(srcIno, "src")!;
  const sourceIno = tree.lookup(srcDirIno, "main.ts")!;
  const sourcePath = bridge.resolveSourceWritePath(sourceIno);

  assertEquals(sourcePath?.spaceName, "did:key:zSource");
  assertEquals(sourcePath?.pieceName, "notes");
  assertEquals(sourcePath?.relPath, "src/main.ts");
});

// ---------------------------------------------------------------------------
// Group 4: syncPieceListOnce — add/remove
// ---------------------------------------------------------------------------

Deno.test("CellBridge.syncPieceListOnce adds a new piece to the tree", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");

  const existingPiece = {
    id: "of:p1",
    name: () => "Piece One",
    getPatternMeta: () => Promise.resolve({}),
    input: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
    result: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
  };

  const newPiece = {
    id: "of:p2",
    name: () => "Piece Two",
    getPatternMeta: () => Promise.resolve({}),
    input: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
    result: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
  };

  // Build the space with only the first piece already added
  const state = buildTestSpace(bridge, "home", [existingPiece, newPiece]);

  const addPiece = (bridge as unknown as { addPieceToSpace: AddPieceToSpace })
    .addPieceToSpace.bind(bridge);
  await addPiece(state, existingPiece, "home");

  // Now the getAllPieces mock already returns both pieces; sync should add p2
  await (bridge as unknown as { syncPieceListOnce: SyncPieceListOnce })
    .syncPieceListOnce.call(bridge, state, "home");

  assertEquals(
    tree.lookup(state.piecesIno, "Piece-Two") !== undefined,
    true,
    "Piece Two directory should appear after sync",
  );
  assertEquals(state.pieceMap.has("Piece-Two"), true);
});

Deno.test("CellBridge.syncPieceListOnce removes a deleted piece from the tree", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");

  const piece = {
    id: "of:gone",
    name: () => "Gone Piece",
    getPatternMeta: () => Promise.resolve({}),
    input: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
    result: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
  };

  // Start with one piece in the tree
  const state = buildTestSpace(bridge, "home", []);

  const addPiece = (bridge as unknown as { addPieceToSpace: AddPieceToSpace })
    .addPieceToSpace.bind(bridge);
  await addPiece(state, piece, "home");

  // Verify it was added
  assertEquals(
    tree.lookup(state.piecesIno, "Gone-Piece") !== undefined,
    true,
    "Piece should exist before sync",
  );

  // Now getAllPieces returns empty — piece was deleted
  state.pieces = {
    getAllPieces: () => Promise.resolve([]),
  } as unknown as SpaceState["pieces"];

  await (bridge as unknown as { syncPieceListOnce: SyncPieceListOnce })
    .syncPieceListOnce.call(bridge, state, "home");

  assertEquals(
    tree.lookup(state.piecesIno, "Gone-Piece"),
    undefined,
    "Piece directory should be gone after sync",
  );
  assertEquals(state.pieceMap.size, 0);
});

// ---------------------------------------------------------------------------
// Group 5: subscribePiece — rename on cell change
// ---------------------------------------------------------------------------

Deno.test({
  name: "CellBridge.subscribePiece renames directory when piece name changes",
  sanitizeOps: false,
  fn: async () => {
    const tree = new FsTree();
    const bridge = new CellBridge(tree, "/tmp/cf-exec");
    const state = buildTestSpace(bridge, "home", []);

    // Mutable name — we'll change it before firing the sink
    let pieceName = "Old Name";

    const resultCell = new SinkableCell({});

    const piece = {
      id: "of:abc",
      name: () => pieceName,
      getPatternMeta: () => Promise.resolve({}),
      input: {
        getCell: () => Promise.resolve(makeCell({}, undefined)),
        get: () => Promise.resolve({}),
      },
      result: {
        getCell: () => Promise.resolve(resultCell as unknown as FakeCell),
        get: () => Promise.resolve({}),
      },
    };

    // First, add the piece to the space to set up the directory and state maps
    const addPiece = (bridge as unknown as { addPieceToSpace: AddPieceToSpace })
      .addPieceToSpace.bind(bridge);
    await addPiece(state, piece, "home");

    // Verify initial state
    assertEquals(
      tree.lookup(state.piecesIno, "Old-Name") !== undefined,
      true,
      "Old Name dir should exist initially",
    );

    // Cancel the addPieceToSpace subs before creating new ones
    const addedSubs = state.pieceSubs.get("Old-Name");
    if (addedSubs) { for (const cancel of addedSubs) cancel(); }

    // Now call subscribePiece separately to attach the rename sink
    const subs = await (bridge as unknown as { subscribePiece: SubscribePiece })
      .subscribePiece.call(
        bridge,
        piece,
        tree.lookup(state.piecesIno, "Old-Name")!,
        "Old-Name",
        "home",
        state,
      );

    // Store updated subs
    state.pieceSubs.set("Old-Name", subs);

    // Change the piece name before firing the sink
    pieceName = "New Name";

    // Trigger the result cell sink — rename is deferred via setTimeout(0)
    resultCell.set({});

    // Wait for the deferred rename to execute
    await new Promise((r) => setTimeout(r, 10));

    assertEquals(
      tree.lookup(state.piecesIno, "New-Name") !== undefined,
      true,
      "New Name dir should exist after rename",
    );
    assertEquals(
      tree.lookup(state.piecesIno, "Old-Name"),
      undefined,
      "Old Name dir should be gone after rename",
    );

    // Cancel all subscriptions (clears debounce timers)
    for (const cancel of subs) cancel();
    for (const [, pieceSubs] of state.pieceSubs) {
      for (const cancel of pieceSubs) cancel();
    }
  },
});

Deno.test("CellBridge.addPieceToSpace normalizes projected piece directory names", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const state = buildTestSpace(bridge, "home", []);

  const piece = {
    id: "of:piece-123",
    name: () => "  Hello, world! 🚀 / notes  ",
    getPatternMeta: () => Promise.resolve({}),
    input: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
    result: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
  };

  const addPiece = (bridge as unknown as { addPieceToSpace: AddPieceToSpace })
    .addPieceToSpace.bind(bridge);
  const projectedName = await addPiece(state, piece, "home");

  assertEquals(projectedName, "Hello-world-notes");
  assertEquals(
    tree.lookup(state.piecesIno, "Hello-world-notes") !== undefined,
    true,
  );
  assertEquals(
    JSON.parse(
      getFileContent(
        tree,
        tree.lookup(state.piecesIno, projectedName)!,
        "meta.json",
      ),
    ).name,
    "  Hello, world! 🚀 / notes  ",
  );
});

Deno.test("CellBridge.addPieceToSpace falls back to a normalized piece id for symbol-only names", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const state = buildTestSpace(bridge, "home", []);

  const piece = {
    id: "of:emoji-piece",
    name: () => "🔥✨",
    getPatternMeta: () => Promise.resolve({}),
    input: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
    result: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
  };

  const addPiece = (bridge as unknown as { addPieceToSpace: AddPieceToSpace })
    .addPieceToSpace.bind(bridge);
  const projectedName = await addPiece(state, piece, "home");

  assertEquals(projectedName, "of-emoji-piece");
  assertEquals(
    tree.lookup(state.piecesIno, "of-emoji-piece") !== undefined,
    true,
  );
});

Deno.test({
  name: "CellBridge.subscribePiece renames directories using normalized names",
  sanitizeOps: false,
  fn: async () => {
    const tree = new FsTree();
    const bridge = new CellBridge(tree, "/tmp/cf-exec");
    const state = buildTestSpace(bridge, "home", []);

    let pieceName = "Start Here";
    const resultCell = new SinkableCell({});

    const piece = {
      id: "of:abc",
      name: () => pieceName,
      getPatternMeta: () => Promise.resolve({}),
      input: {
        getCell: () => Promise.resolve(makeCell({}, undefined)),
        get: () => Promise.resolve({}),
      },
      result: {
        getCell: () => Promise.resolve(resultCell as unknown as FakeCell),
        get: () => Promise.resolve({}),
      },
    };

    const addPiece = (bridge as unknown as { addPieceToSpace: AddPieceToSpace })
      .addPieceToSpace.bind(bridge);
    await addPiece(state, piece, "home");

    // Cancel the addPieceToSpace subs before creating new ones
    const addedSubs = state.pieceSubs.get("Start-Here");
    if (addedSubs) { for (const cancel of addedSubs) cancel(); }

    const subs = await (bridge as unknown as { subscribePiece: SubscribePiece })
      .subscribePiece.call(
        bridge,
        piece,
        tree.lookup(state.piecesIno, "Start-Here")!,
        "Start-Here",
        "home",
        state,
      );

    state.pieceSubs.set("Start-Here", subs);

    pieceName = "Renamed 🚀 Piece";
    resultCell.set({});
    await new Promise((r) => setTimeout(r, 10));

    assertEquals(
      tree.lookup(state.piecesIno, "Renamed-Piece") !== undefined,
      true,
    );
    assertEquals(tree.lookup(state.piecesIno, "Start-Here"), undefined);

    // Cancel all subscriptions (clears debounce timers)
    for (const cancel of subs) cancel();
    for (const [, pieceSubs] of state.pieceSubs) {
      for (const cancel of pieceSubs) cancel();
    }
  },
});

Deno.test("CellBridge.subscribePiece clears stale FS root entries when result switches to result/ tree", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const state = buildTestSpace(bridge, "home", []);

  const inputCell = new SinkableCell({});
  const resultCell = new SinkableCell({
    $FS: {
      type: "text/markdown",
      content: "Hello",
      frontmatter: {
        meta: {
          pinned: true,
        },
      },
    },
  });

  const piece = {
    id: "of:fs-piece",
    name: () => "FS Piece",
    getPatternMeta: () => Promise.resolve({}),
    input: {
      getCell: () => Promise.resolve(inputCell as unknown as FakeCell),
      get: () => Promise.resolve(inputCell.get()),
    },
    result: {
      getCell: () => Promise.resolve(resultCell as unknown as FakeCell),
      get: () => Promise.resolve(resultCell.get()),
    },
  };

  const addPiece = (bridge as unknown as { addPieceToSpace: AddPieceToSpace })
    .addPieceToSpace.bind(bridge);
  await addPiece(state, piece, "home");

  const pieceIno = tree.lookup(state.piecesIno, "FS-Piece")!;
  await (bridge as unknown as { hydratePieceProp: HydratePieceProp })
    .hydratePieceProp.call(bridge, pieceIno, "result");
  assertEquals(tree.lookup(pieceIno, "index.md") !== undefined, true);
  assertEquals(tree.lookup(pieceIno, "meta") !== undefined, true);
  assertEquals(tree.lookup(pieceIno, "result"), undefined);

  resultCell.set({ content: "Now a regular result tree" });
  await new Promise((r) => setTimeout(r, 10));
  bridge.invalidateWritePath({
    spaceName: "home",
    pieceName: "FS-Piece",
    cell: "result",
    jsonPath: ["content"],
    isJsonFile: false,
    piece: piece as unknown as WritePath["piece"],
  });
  await (bridge as unknown as { hydratePieceProp: HydratePieceProp })
    .hydratePieceProp.call(bridge, pieceIno, "result");

  const resultIno = tree.lookup(pieceIno, "result");
  assertEquals(resultIno !== undefined, true, "result/ dir should exist");
  assertEquals(
    tree.lookup(pieceIno, "index.md"),
    undefined,
    "index.md should be removed when leaving FS projection mode",
  );
  assertEquals(
    tree.lookup(pieceIno, "meta"),
    undefined,
    "Complex frontmatter dirs should be removed when leaving FS projection mode",
  );
  assertEquals(
    resultIno !== undefined ? getFileContent(tree, resultIno, "content") : "",
    "Now a regular result tree",
  );

  // Cancel subscriptions to avoid timer leaks
  const subs = state.pieceSubs.get("FS-Piece");
  if (subs) { for (const cancel of subs) cancel(); }
});

Deno.test("CellBridge hydrates and writes back markdown FS projection scalars", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const state = buildTestSpace(bridge, "home", []);
  const writes: Array<{ path: (string | number)[]; value: unknown }> = [];
  const resultValue = {
    $FS: {
      type: "text/markdown",
      content: "Hello body",
      frontmatter: {
        entityId: "user-supplied-entity",
        title: "Hello",
        count: 7,
        published: false,
        tags: ["alpha", "beta"],
        meta: { pinned: true },
      },
    },
  };
  const inputCell = new SinkableCell({});
  const resultCell = new SinkableCell(resultValue);

  const piece = {
    id: "of:fs-roundtrip",
    name: () => "FS Roundtrip",
    getPatternMeta: () => Promise.resolve({}),
    input: {
      getCell: () => Promise.resolve(inputCell as unknown as FakeCell),
      get: () => Promise.resolve(inputCell.get()),
    },
    result: {
      getCell: () => Promise.resolve(resultCell as unknown as FakeCell),
      get: (path?: (string | number)[]) => {
        if (path?.join("/") === "$FS/frontmatter") {
          return Promise.resolve(resultValue.$FS.frontmatter);
        }
        return Promise.resolve(resultCell.get());
      },
      set: (value: unknown, path?: (string | number)[]) => {
        writes.push({ path: path ?? [], value });
        return Promise.resolve();
      },
    },
  };

  const addPiece = (bridge as unknown as { addPieceToSpace: AddPieceToSpace })
    .addPieceToSpace.bind(bridge);
  await addPiece(state, piece, "home");

  const pieceIno = tree.lookup(state.piecesIno, "FS-Roundtrip")!;
  await (bridge as unknown as { hydratePieceProp: HydratePieceProp })
    .hydratePieceProp.call(bridge, pieceIno, "result");

  const index = getFileContent(tree, pieceIno, "index.md");
  assertEquals(
    index,
    "---\nentityId: of:fs-roundtrip\ntitle: Hello\ncount: 7\npublished: false\n---\n\nHello body",
  );
  const tagsIno = tree.lookup(pieceIno, "tags")!;
  assertEquals(getFileContent(tree, tagsIno, "0"), "alpha");
  assertEquals(getFileContent(tree, tagsIno, "1"), "beta");
  const metaIno = tree.lookup(pieceIno, "meta")!;
  assertEquals(getFileContent(tree, metaIno, "pinned"), "true");

  const ok = await (bridge as unknown as { writeFsFile: WriteFsFile })
    .writeFsFile(
      {
        fsProjection: "markdown",
        piece: piece as unknown as WritePath["piece"],
      },
      "---\nentityId: attacker\ntitle: Updated\ncount: 8\npublished: true\n---\n\nUpdated body",
    );

  assertEquals(ok, true);
  assertEquals(writes, [
    { path: ["$FS", "frontmatter", "title"], value: "Updated" },
    { path: ["$FS", "frontmatter", "count"], value: 8 },
    { path: ["$FS", "frontmatter", "published"], value: true },
    { path: ["$FS", "frontmatter", "tags"], value: undefined },
    { path: ["$FS", "frontmatter", "meta"], value: undefined },
    { path: ["$FS", "content"], value: "Updated body" },
  ]);
});

Deno.test({
  name: "CellBridge.status tracks debounced rebuild metrics",
  sanitizeOps: false,
  fn: async () => {
    const tree = new FsTree();
    let cfcReconciliations = 0;
    const bridge = new CellBridge(tree, "/tmp/cf-exec", {
      statusProvider: () => ({
        cfc: {
          writeback: {
            counts: { "mutation-applied": cfcReconciliations },
          },
        },
      }),
      onCfcProjectionRebuilt: () => {
        cfcReconciliations++;
      },
    });
    bridge.init({
      apiUrl: "http://localhost:8000",
      identity: "/tmp/test-identity.pem",
    });
    bridge.initStatus();
    const state = buildTestSpace(bridge, "home", []);

    const inputCell = new SinkableCell({});
    const resultCell = new SinkableCell({ content: "Initial" });

    const piece = {
      id: "of:status-piece",
      name: () => "Status Piece",
      getPatternMeta: () => Promise.resolve({}),
      input: {
        getCell: () => Promise.resolve(inputCell as unknown as FakeCell),
        get: () => Promise.resolve(resultCell.get()),
      },
      result: {
        getCell: () => Promise.resolve(resultCell as unknown as FakeCell),
        get: () => Promise.resolve(resultCell.get()),
      },
    };

    const addPiece = (bridge as unknown as { addPieceToSpace: AddPieceToSpace })
      .addPieceToSpace.bind(bridge);
    await addPiece(state, piece, "home");

    const pieceIno = tree.lookup(state.piecesIno, "Status-Piece")!;
    assertEquals(tree.lookup(pieceIno, "result") !== undefined, true);
    assertEquals(tree.getChildren(tree.lookup(pieceIno, "result")!).length, 0);

    resultCell.set({ content: "Second" });
    resultCell.set({ content: "Final" });
    // Wait for debounce (150ms) + rebuild
    await new Promise((r) => setTimeout(r, 250));

    const resultIno = tree.lookup(pieceIno, "result")!;
    assertEquals(getFileContent(tree, resultIno, "content"), "Final");

    const status = JSON.parse(getFileContent(tree, tree.rootIno, ".status"));
    assertEquals(status.debug, false);
    assertEquals(status.rebuilds.pending, 0);
    assertEquals(status.rebuilds.completed >= 1, true);
    assertEquals(status.rebuilds.errors, 0);
    assertEquals(cfcReconciliations >= 1, true);
    assertEquals(
      status.cfc.writeback.counts["mutation-applied"],
      cfcReconciliations,
    );

    // Cancel subscriptions to avoid timer leaks
    const subs = state.pieceSubs.get("Status-Piece");
    if (subs) { for (const cancel of subs) cancel(); }
  },
});

Deno.test({
  name:
    "CellBridge.subscribePiece falls back to a pulled value when sink updates are undefined",
  sanitizeOps: false,
  fn: async () => {
    const tree = new FsTree();
    const bridge = new CellBridge(tree, "/tmp/cf-exec");
    const state = buildTestSpace(bridge, "home", []);

    const inputCell = new SinkableCell({});
    const resultCell = new SinkableCell({ content: "Initial" });

    const piece = {
      id: "of:undefined-sink-piece",
      name: () => "Undefined Sink Piece",
      getPatternMeta: () => Promise.resolve({}),
      input: {
        getCell: () => Promise.resolve(inputCell as unknown as FakeCell),
        get: () => Promise.resolve(inputCell.get()),
      },
      result: {
        getCell: () => Promise.resolve(resultCell as unknown as FakeCell),
        get: () => Promise.resolve({ content: "Pulled fallback" }),
      },
    };

    const addPiece = (bridge as unknown as { addPieceToSpace: AddPieceToSpace })
      .addPieceToSpace.bind(bridge);
    await addPiece(state, piece, "home");

    const pieceIno = tree.lookup(state.piecesIno, "Undefined-Sink-Piece")!;
    await (bridge as unknown as { hydratePieceProp: HydratePieceProp })
      .hydratePieceProp.call(bridge, pieceIno, "result");
    resultCell.set(undefined);
    await new Promise((r) => setTimeout(r, 250));

    const resultIno = tree.lookup(pieceIno, "result");
    assertEquals(resultIno !== undefined, true);
    assertEquals(
      getFileContent(tree, resultIno!, "content"),
      "Pulled fallback",
    );

    const subs = state.pieceSubs.get("Undefined-Sink-Piece");
    if (subs) { for (const cancel of subs) cancel(); }
  },
});

Deno.test({
  name:
    "CellBridge.subscribePiece keeps the mounted result when undefined updates have no replacement yet",
  sanitizeOps: false,
  fn: async () => {
    const tree = new FsTree();
    const bridge = new CellBridge(tree, "/tmp/cf-exec");
    const state = buildTestSpace(bridge, "home", []);

    const inputCell = new SinkableCell({});
    const resultCell = new SinkableCell({ content: "Initial" });
    let getterValue: unknown = { content: "Initial" };

    const piece = {
      id: "of:undefined-transient-piece",
      name: () => "Undefined Transient Piece",
      getPatternMeta: () => Promise.resolve({}),
      input: {
        getCell: () => Promise.resolve(inputCell as unknown as FakeCell),
        get: () => Promise.resolve(inputCell.get()),
      },
      result: {
        getCell: () => Promise.resolve(resultCell as unknown as FakeCell),
        get: () => Promise.resolve(getterValue),
      },
    };

    const addPiece = (bridge as unknown as { addPieceToSpace: AddPieceToSpace })
      .addPieceToSpace.bind(bridge);
    await addPiece(state, piece, "home");

    const pieceIno = tree.lookup(state.piecesIno, "Undefined-Transient-Piece")!;
    await (bridge as unknown as { hydratePieceProp: HydratePieceProp })
      .hydratePieceProp.call(bridge, pieceIno, "result");

    getterValue = undefined;
    resultCell.set(undefined);
    await new Promise((r) => setTimeout(r, 250));

    const resultIno = tree.lookup(pieceIno, "result");
    assertEquals(resultIno !== undefined, true);
    assertEquals(getFileContent(tree, resultIno!, "content"), "Initial");

    const subs = state.pieceSubs.get("Undefined-Transient-Piece");
    if (subs) { for (const cancel of subs) cancel(); }
  },
});

Deno.test("CellBridge.invalidateWritePath clears hydrated piece result cache", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const state = buildTestSpace(bridge, "home", []);

  const piece = {
    id: "of:invalidate-piece",
    name: () => "Invalidate Piece",
    getPatternMeta: () => Promise.resolve({}),
    input: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
    result: {
      getCell: () =>
        Promise.resolve(makeCell({ content: "hello" }, {
          type: "object",
          properties: { content: { type: "string" } },
        })),
      get: () => Promise.resolve({ content: "hello" }),
    },
  };

  const addPiece = (bridge as unknown as { addPieceToSpace: AddPieceToSpace })
    .addPieceToSpace.bind(bridge);
  await addPiece(state, piece, "home");

  const pieceIno = tree.lookup(state.piecesIno, "Invalidate-Piece")!;
  await (bridge as unknown as { hydratePieceProp: HydratePieceProp })
    .hydratePieceProp.call(bridge, pieceIno, "result");
  assertEquals(tree.lookup(pieceIno, "result") !== undefined, true);

  bridge.invalidateWritePath({
    spaceName: "home",
    pieceName: "Invalidate-Piece",
    cell: "result",
    jsonPath: ["content"],
    isJsonFile: false,
    piece: piece as unknown as WritePath["piece"],
  });

  const resultIno = tree.lookup(pieceIno, "result");
  assertEquals(resultIno !== undefined, true);
  assertEquals(
    tree.getChildren(resultIno!).length,
    0,
    "result/ should be restored as an empty stub after invalidation",
  );
});

Deno.test("CellBridge.invalidateHandlerTarget clears hydrated entity result cache", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const state = buildTestSpace(bridge, "home", []);

  const resultCell = makeCell({ content: "hello" }, {
    type: "object",
    properties: { content: { type: "string" } },
  });
  const piece = {
    id: "of:entity-handler-piece",
    name: () => "Handler Piece",
    getPatternMeta: () => Promise.resolve({}),
    input: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
    result: {
      getCell: () => Promise.resolve(resultCell),
      get: () => Promise.resolve({ content: "hello" }),
    },
    manager: () => ({
      runtime: { idle: () => Promise.resolve() },
      synced: () => Promise.resolve(),
    }),
  };

  const addPiece = (bridge as unknown as { addPieceToSpace: AddPieceToSpace })
    .addPieceToSpace.bind(bridge);
  await addPiece(state, piece, "home");

  await bridge.resolveEntity(state.entitiesIno, "of%3Aentity-handler-piece");
  const entityIno = tree.lookup(
    state.entitiesIno,
    "of%3Aentity-handler-piece",
  )!;
  await (bridge as unknown as { hydratePieceProp: HydratePieceProp })
    .hydratePieceProp.call(bridge, entityIno, "result");
  assertEquals(tree.lookup(entityIno, "result") !== undefined, true);

  bridge.invalidateHandlerTarget({
    piece: piece as unknown as HandlerTarget["piece"],
    cellProp: "result",
    cellKey: "content",
  });

  const resultIno = tree.lookup(entityIno, "result");
  assertEquals(resultIno !== undefined, true);
  assertEquals(
    tree.getChildren(resultIno!).length,
    0,
    "entity result/ should be restored as an empty stub after handler invalidation",
  );
});

Deno.test("CellBridge.resolveEntity rejects non-canonical entity aliases", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const state = buildTestSpace(bridge, "home", []);
  const piece = {
    id: "of:alias-piece",
    name: () => "Alias Piece",
    getPatternMeta: () => Promise.resolve({}),
    input: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
    result: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
    manager: () => ({
      runtime: { idle: () => Promise.resolve() },
      synced: () => Promise.resolve(),
    }),
  };
  state.pieceControllers.set("Alias-Piece", piece as never);

  assertEquals(
    await bridge.resolveEntity(state.entitiesIno, "of:alias-piece"),
    false,
  );
  assertEquals(
    await bridge.resolveEntity(state.entitiesIno, "%6Ff%3Aalias-piece"),
    false,
  );
  assertEquals(tree.lookup(state.entitiesIno, "of:alias-piece"), undefined);
  assertEquals(tree.lookup(state.entitiesIno, "%6Ff%3Aalias-piece"), undefined);

  assertEquals(
    await bridge.resolveEntity(state.entitiesIno, "of%3Aalias-piece"),
    true,
  );
  assertEquals(
    tree.lookup(state.entitiesIno, "of%3Aalias-piece") !== undefined,
    true,
  );
});

Deno.test("CellBridge.invalidateWritePath does not spawn concurrent hydrations for the same prop", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const state = buildTestSpace(bridge, "home", []);

  let resolveFirstGet: (() => void) | undefined;
  const firstGetGate = new Promise<void>((resolve) => {
    resolveFirstGet = resolve;
  });
  let getCalls = 0;
  let maxConcurrentGets = 0;
  let activeGets = 0;

  const piece = {
    id: "of:race-piece",
    name: () => "Race Piece",
    getPatternMeta: () => Promise.resolve({}),
    input: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
    result: {
      getCell: () =>
        Promise.resolve(makeCell({ content: "fresh" }, {
          type: "object",
          properties: { content: { type: "string" } },
        })),
      get: async () => {
        getCalls++;
        activeGets++;
        maxConcurrentGets = Math.max(maxConcurrentGets, activeGets);
        try {
          if (getCalls === 2) {
            await firstGetGate;
          }
          return { content: "fresh" };
        } finally {
          activeGets--;
        }
      },
    },
  };

  const addPiece = (bridge as unknown as { addPieceToSpace: AddPieceToSpace })
    .addPieceToSpace.bind(bridge);
  await addPiece(state, piece, "home");

  const pieceIno = tree.lookup(state.piecesIno, "Race-Piece")!;
  const firstHydration = (bridge as unknown as {
    hydratePieceProp: HydratePieceProp;
  }).hydratePieceProp.call(bridge, pieceIno, "result");

  await Promise.resolve();
  bridge.invalidateWritePath({
    spaceName: "home",
    pieceName: "Race-Piece",
    cell: "result",
    jsonPath: ["content"],
    isJsonFile: false,
    piece: piece as unknown as WritePath["piece"],
  });
  const secondHydration = (bridge as unknown as {
    hydratePieceProp: HydratePieceProp;
  }).hydratePieceProp.call(bridge, pieceIno, "result");

  if (resolveFirstGet) resolveFirstGet();
  await Promise.all([firstHydration, secondHydration]);

  assertEquals(maxConcurrentGets, 1);
  assertEquals(getCalls >= 2, true);
  const resultIno = tree.lookup(pieceIno, "result");
  assertEquals(resultIno !== undefined, true);
  assertEquals(getFileContent(tree, resultIno!, "content"), "fresh");
});
