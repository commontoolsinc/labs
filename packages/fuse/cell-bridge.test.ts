// cell-bridge.test.ts — Integration tests for CellBridge using fake piece objects
import { assertEquals } from "@std/assert";
import { FsTree } from "./tree.ts";
import { CellBridge, type SpaceState } from "./cell-bridge.ts";

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
  const spaceIno = tree.addDir(tree.rootIno, spaceName);
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
) => Promise<Array<() => void>>;

type WriteFsFile = (
  writePath: unknown,
  text: string,
) => Promise<boolean>;

// ---------------------------------------------------------------------------
// Group 1: loadPieceTree — initial tree structure
// ---------------------------------------------------------------------------

Deno.test("CellBridge.loadPieceTree creates meta.json with id, name, patternName", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/ct-exec");

  const piece = {
    id: "of:entity-123",
    name: () => "My Note",
    getPatternMeta: () => Promise.resolve({ patternName: "note" }),
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
  assertEquals(meta.patternName, "note");
});

Deno.test("CellBridge.loadPieceTree creates input/ dir with leaf files", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/ct-exec");

  const piece = {
    id: "of:entity-456",
    name: () => "Article",
    getPatternMeta: () => Promise.resolve({ patternName: "article" }),
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
  assertEquals(inputIno !== undefined, true, "input/ dir should exist");

  const titleContent = getFileContent(tree, inputIno!, "title");
  assertEquals(titleContent, "hello");
});

Deno.test("CellBridge.loadPieceTree creates result/ dir with leaf files", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/ct-exec");

  const piece = {
    id: "of:entity-789",
    name: () => "Post",
    getPatternMeta: () => Promise.resolve({ patternName: "post" }),
    input: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
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

  const pieceIno = await (bridge as unknown as { loadPieceTree: LoadPieceTree })
    .loadPieceTree(piece, tree.rootIno, "Post", "home");

  const resultIno = tree.lookup(pieceIno, "result");
  assertEquals(resultIno !== undefined, true, "result/ dir should exist");

  const contentValue = getFileContent(tree, resultIno!, "content");
  assertEquals(contentValue, "world");
});

Deno.test("CellBridge.loadPieceTree labels void handlers as no-arg callables in .handlers", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/ct-exec");

  const onAddContactCell = makeCell(
    { $stream: true },
    { asStream: true },
    {},
    { isStream: true },
  );
  const resultCell = makeCell(
    { onAddContact: { $stream: true } },
    {
      type: "object",
      properties: {
        onAddContact: { asStream: true },
      },
    },
    { onAddContact: onAddContactCell },
  );

  const piece = {
    id: "of:entity-void-handler",
    name: () => "Contact Book",
    getPatternMeta: () => Promise.resolve({ patternName: "contact-book" }),
    input: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
    result: {
      getCell: () => Promise.resolve(resultCell),
      get: () => Promise.resolve({ onAddContact: { $stream: true } }),
    },
  };

  const pieceIno = await (bridge as unknown as { loadPieceTree: LoadPieceTree })
    .loadPieceTree(piece, tree.rootIno, "Contact Book", "home");

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
  const bridge = new CellBridge(tree, "/tmp/ct-exec");
  const state = buildTestSpace(bridge, "home", []);

  const makeNotePiece = (id: string) => ({
    id,
    name: () => "My Note",
    getPatternMeta: () => Promise.resolve({ patternName: "note" }),
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

  assertEquals(name1, "My Note");
  assertEquals(name2, "My Note-2");

  // Both entries should be in pieceMap
  assertEquals(state.pieceMap.has("My Note"), true);
  assertEquals(state.pieceMap.has("My Note-2"), true);

  // Both directories should exist in the tree
  assertEquals(tree.lookup(state.piecesIno, "My Note") !== undefined, true);
  assertEquals(tree.lookup(state.piecesIno, "My Note-2") !== undefined, true);
});

Deno.test("CellBridge.addPieceToSpace assigns -2 and -3 suffixes for three collisions", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/ct-exec");
  const state = buildTestSpace(bridge, "home", []);

  const makeStandupPiece = (id: string) => ({
    id,
    name: () => "Standup",
    getPatternMeta: () => Promise.resolve({ patternName: "standup" }),
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
  const bridge = new CellBridge(tree, "/tmp/ct-exec");
  const state = buildTestSpace(bridge, "home", []);

  const addPiece = (bridge as unknown as { addPieceToSpace: AddPieceToSpace })
    .addPieceToSpace.bind(bridge);

  await addPiece(
    state,
    {
      id: "of:alpha",
      name: () => "Alpha",
      getPatternMeta: () => Promise.resolve({ patternName: "alpha" }),
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
      getPatternMeta: () => Promise.resolve({ patternName: "beta" }),
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
  const bridge = new CellBridge(tree, "/tmp/ct-exec");
  const state = buildTestSpace(bridge, "home", []);

  state.pieceMap.set("Alpha", "of:alpha");
  state.pieceMap.set("Beta", "of:beta");
  state.pieceManifest.set("of:alpha", {
    pattern: "alpha-pattern",
    summary: "alpha summary",
  });
  state.pieceManifest.set("of:beta", {
    pattern: "beta-pattern",
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
      pattern: "alpha-pattern",
      summary: "alpha summary",
      entityPath: "entities/of:alpha",
    },
    {
      id: "of:beta",
      name: "Beta",
      pattern: "beta-pattern",
      summary: "beta summary",
      entityPath: "entities/of:beta",
    },
  ]);
});

Deno.test("CellBridge result rebuild updates pieces.json summary from cached manifest", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/ct-exec");
  const state = buildTestSpace(bridge, "home", []);
  const resultCell = new SinkableCell({ summary: "before" });

  const piece = {
    id: "of:summary-piece",
    name: () => "Summary Piece",
    getPatternMeta: () => Promise.resolve({ patternName: "summary-pattern" }),
    input: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
    result: {
      getCell: () => Promise.resolve(resultCell as unknown as FakeCell),
      get: () => Promise.resolve({ summary: "before" }),
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
  await new Promise((resolve) => setTimeout(resolve, 30));

  piecesJson = JSON.parse(getFileContent(tree, state.piecesIno, "pieces.json"));
  assertEquals(piecesJson[0].summary, "after");
});

Deno.test("CellBridge.writeFsFile writes markdown frontmatter and body to FS paths", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/ct-exec");
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
  const bridge = new CellBridge(tree, "/tmp/ct-exec");
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
  const bridge = new CellBridge(tree, "/tmp/ct-exec");
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

// ---------------------------------------------------------------------------
// Group 4: syncPieceListOnce — add/remove
// ---------------------------------------------------------------------------

Deno.test("CellBridge.syncPieceListOnce adds a new piece to the tree", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/ct-exec");

  const existingPiece = {
    id: "of:p1",
    name: () => "Piece One",
    getPatternMeta: () => Promise.resolve({ patternName: "note" }),
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
    getPatternMeta: () => Promise.resolve({ patternName: "note" }),
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
    tree.lookup(state.piecesIno, "Piece Two") !== undefined,
    true,
    "Piece Two directory should appear after sync",
  );
  assertEquals(state.pieceMap.has("Piece Two"), true);
});

Deno.test("CellBridge.syncPieceListOnce removes a deleted piece from the tree", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/ct-exec");

  const piece = {
    id: "of:gone",
    name: () => "Gone Piece",
    getPatternMeta: () => Promise.resolve({ patternName: "note" }),
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
    tree.lookup(state.piecesIno, "Gone Piece") !== undefined,
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
    tree.lookup(state.piecesIno, "Gone Piece"),
    undefined,
    "Piece directory should be gone after sync",
  );
  assertEquals(state.pieceMap.size, 0);
});

// ---------------------------------------------------------------------------
// Group 5: subscribePiece — rename on cell change
// ---------------------------------------------------------------------------

Deno.test("CellBridge.subscribePiece renames directory when piece name changes", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/ct-exec");
  const state = buildTestSpace(bridge, "home", []);

  // Mutable name — we'll change it before firing the sink
  let pieceName = "Old Name";

  const resultCell = new SinkableCell({});

  const piece = {
    id: "of:abc",
    name: () => pieceName,
    getPatternMeta: () => Promise.resolve({ patternName: "note" }),
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
    tree.lookup(state.piecesIno, "Old Name") !== undefined,
    true,
    "Old Name dir should exist initially",
  );

  // Now call subscribePiece separately to attach the rename sink
  const subs = await (bridge as unknown as { subscribePiece: SubscribePiece })
    .subscribePiece.call(
      bridge,
      piece,
      tree.lookup(state.piecesIno, "Old Name")!,
      "Old Name",
      "home",
    );

  // Store updated subs
  state.pieceSubs.set("Old Name", subs);

  // Change the piece name before firing the sink
  pieceName = "New Name";

  // Trigger the result cell sink — rename is deferred via setTimeout(0)
  resultCell.set({});

  // Wait for the deferred rename to execute
  await new Promise((r) => setTimeout(r, 10));

  assertEquals(
    tree.lookup(state.piecesIno, "New Name") !== undefined,
    true,
    "New Name dir should exist after rename",
  );
  assertEquals(
    tree.lookup(state.piecesIno, "Old Name"),
    undefined,
    "Old Name dir should be gone after rename",
  );
});

Deno.test("CellBridge.subscribePiece clears stale FS root entries when result switches to result/ tree", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/ct-exec");
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
    getPatternMeta: () => Promise.resolve({ patternName: "note" }),
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

  const pieceIno = tree.lookup(state.piecesIno, "FS Piece")!;
  assertEquals(tree.lookup(pieceIno, "index.md") !== undefined, true);
  assertEquals(tree.lookup(pieceIno, "meta") !== undefined, true);
  assertEquals(tree.lookup(pieceIno, "result"), undefined);

  resultCell.set({ content: "Now a regular result tree" });
  await new Promise((r) => setTimeout(r, 10));

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
});

Deno.test("CellBridge.status tracks coalesced rebuild metrics", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/ct-exec");
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
    getPatternMeta: () => Promise.resolve({ patternName: "note" }),
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

  const pieceIno = tree.lookup(state.piecesIno, "Status Piece")!;

  resultCell.set({ content: "Second" });
  resultCell.set({ content: "Final" });
  await new Promise((r) => setTimeout(r, 10));

  const resultIno = tree.lookup(pieceIno, "result")!;
  assertEquals(getFileContent(tree, resultIno, "content"), "Final");

  const status = JSON.parse(getFileContent(tree, tree.rootIno, ".status"));
  assertEquals(status.debug, false);
  assertEquals(status.rebuilds.pending, 0);
  assertEquals(status.rebuilds.scheduled, 1);
  assertEquals(status.rebuilds.coalesced, 1);
  assertEquals(status.rebuilds.completed, 1);
  assertEquals(status.rebuilds.errors, 0);
  assertEquals(status.rebuilds.maxPending, 1);
});
