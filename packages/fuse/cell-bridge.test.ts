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

  constructor(value: unknown) {
    this._value = value;
  }

  get() {
    return this._value;
  }

  getRaw() {
    return this._value;
  }

  set(v: unknown) {
    this._value = v;
    for (const fn of this._sinks) fn(v);
  }

  asSchemaFromLinks(): FakeCell {
    return this as unknown as FakeCell;
  }

  key(_s: string): FakeCell {
    return this as unknown as FakeCell;
  }

  sink(fn: (v: unknown) => void): () => void {
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
    pieceSubs: new Map(),
    did: "did:key:zTest",
    unsubscribes: [],
    usedNames: new Set(),
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

type UpdatePiecesJson = (state: SpaceState) => Promise<void>;

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
