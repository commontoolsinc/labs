// cell-bridge.test.ts — Integration tests for CellBridge using fake piece objects
import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { defer } from "@commonfabric/utils/defer";
import { createSession, Identity } from "@commonfabric/identity";
import type { Signer } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { PieceManager } from "@commonfabric/piece";
import { Runtime } from "@commonfabric/runner";
import {
  type Options as V2StorageOptions,
  type SessionFactory,
  StorageManager as V2StorageManager,
} from "../runner/src/storage/v2.ts";
import { FsTree } from "./tree.ts";
import {
  CellBridge,
  type HandlerTarget,
  type SpaceState,
  type WritePath,
} from "./cell-bridge.ts";
import {
  collectDirectorySnapshot,
  DirectoryHandleMap,
  prepareDirectoryForHandle,
} from "./directory-handles.ts";
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

class PatternIdentityCell {
  #sinks = new Map<string, Set<() => void>>();

  asSchema() {
    return { sync: () => Promise.resolve() };
  }

  sinkMeta(key: string, sink: () => void): () => void {
    let sinks = this.#sinks.get(key);
    if (!sinks) {
      sinks = new Set();
      this.#sinks.set(key, sinks);
    }
    sinks.add(sink);
    return () => {
      const current = this.#sinks.get(key);
      current?.delete(sink);
      if (current?.size === 0) this.#sinks.delete(key);
    };
  }

  emit(key = "patternIdentity"): void {
    for (const sink of this.#sinks.get(key) ?? []) sink();
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
 * Read `.status` the way the daemon serves it: the getattr that reports the
 * file's size publishes a render, and the read that follows serves those bytes.
 */
function readStatusFile(tree: FsTree): string {
  tree.refreshGenerated(tree.lookup(tree.rootIno, ".status")!);
  return getFileContent(tree, tree.rootIno, ".status");
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
    manager: {
      listEntityIds: () => Promise.resolve(undefined),
      getPieces: () => Promise.resolve({ sink: () => () => {} }),
    } as unknown as SpaceState["manager"],
    pieces: {
      getAllPieces: () => Promise.resolve(fakePieces),
    } as unknown as SpaceState["pieces"],
    spaceIno,
    piecesIno,
    entitiesIno,
    pieceMap: new Map(),
    pieceInos: new Map(),
    pieceControllers: new Map(),
    entityControllers: new Map(),
    allPieceIds: new Set(),
    entityIds: new Set(),
    piecesHydrated: true,
    piecesMaterializing: false,
    pieceListSubscribed: true,
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

async function openDirectorySnapshot(
  bridge: CellBridge,
  ino: bigint,
) {
  const handles = new DirectoryHandleMap();
  const fh = handles.open(ino);
  const prepared = await prepareDirectoryForHandle(handles, fh, ino, bridge);
  return prepared ?? handles.snapshot(
    fh,
    ino,
    () => collectDirectorySnapshot(bridge.tree, ino),
  );
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

type RefreshPiecePatternMetadata = (
  state: SpaceState,
  piece: unknown,
  pieceIno: bigint,
) => Promise<void>;

type WriteFsFile = (
  writePath: unknown,
  text: string,
) => Promise<boolean>;

Deno.test("mounted /entities recursive directory listing transfers fids without entity bytes", async () => {
  const tree = new FsTree();
  const allPiecesEntityId = "of:fid1:piece-in-all-pieces";
  const entityIds = [
    allPiecesEntityId,
    "of:fid1:entity-alpha",
    "of:fid1:entity-beta",
    "of:fid1:entity-gamma",
  ].toSorted();
  let identifierRequests = 0;
  let identifierLookups = 0;
  let entityValueRequests = 0;
  let pieceListRequests = 0;
  const rejectEntityValueRequest = () => {
    entityValueRequests++;
    throw new Error("entity values must not be requested while listing");
  };
  const listedPieceCell = {
    entityId: { "/": allPiecesEntityId },
    asSchema() {
      return this;
    },
    get: rejectEntityValueRequest,
    getRaw: rejectEntityValueRequest,
    sync: rejectEntityValueRequest,
  };
  const piecesCell = { sink: () => () => {} };
  const manager = {
    getSpace: () => "did:key:zEntityListSpace",
    getPieces: () => {
      pieceListRequests++;
      return Promise.resolve(piecesCell);
    },
    syncPieces: () => {
      pieceListRequests++;
      return Promise.resolve([listedPieceCell]);
    },
    listEntityIdPage: () => {
      identifierRequests++;
      return Promise.resolve({ serverSeq: 7, ids: [...entityIds] });
    },
    entityIdExists: (id: string) => {
      identifierLookups++;
      return Promise.resolve(entityIds.includes(id));
    },
    get: rejectEntityValueRequest,
  } as unknown as SpaceState["manager"];
  let deferredSpaceCellSync = false;
  const bridge = new CellBridge(tree, "/tmp/cf-exec", {
    loadManager: (config) => {
      deferredSpaceCellSync = config.deferSpaceCellSync === true;
      return Promise.resolve(manager);
    },
  });
  bridge.init({ apiUrl: "https://example.invalid", identity: "test" });
  bridge.initStatus();

  const state = await bridge.connectSpace("home");
  assertEquals(JSON.parse(readStatusFile(tree)).spaces.home, {
    did: "did:key:zEntityListSpace",
    pieces: 0,
    piecesLoaded: false,
  });
  assertEquals(identifierRequests, 0);
  const entries = await openDirectorySnapshot(bridge, state.entitiesIno);
  assertEquals(
    entries.slice(2).map(({ name }) => name),
    entityIds.map((id) => encodeFuseComponent(id)),
  );
  assertEquals(tree.getChildren(state.entitiesIno), []);

  for (const { name } of entries.slice(2)) {
    assertEquals(await bridge.prepareLookup(state.entitiesIno, name), true);
    const ino = tree.lookup(state.entitiesIno, name)!;
    assertEquals(tree.getNode(ino)?.kind, "dir");
    assertEquals(
      (await openDirectorySnapshot(bridge, ino)).map(({ name }) => name),
      [".", ".."],
    );
  }

  assertEquals(identifierRequests, 1);
  assertEquals(identifierLookups, entityIds.length);
  assertEquals(entityValueRequests, 0);
  assertEquals(pieceListRequests, 0);
  assertEquals(deferredSpaceCellSync, true);
  assertEquals(state.pieceMap.size, 0);
  assertEquals(state.allPieceIds, new Set());
});

Deno.test("CellBridge prepares a stable paginated entity identifier snapshot", async () => {
  const ids = Array.from(
    { length: 1_205 },
    (_, index) => `of:fid1:entity-${index.toString().padStart(4, "0")}`,
  );
  const requests: Array<Record<string, unknown>> = [];
  const manager = {
    getSpace: () => "did:key:zPaginatedEntitySpace",
    listEntityIdPage: (options: {
      after?: string;
      limit?: number;
      expectedServerSeq?: number;
    }) => {
      requests.push({ ...options });
      const start = options.after === undefined
        ? 0
        : ids.indexOf(options.after) + 1;
      const pageIds = ids.slice(start, start + options.limit!);
      const hasMore = start + pageIds.length < ids.length;
      return Promise.resolve({
        serverSeq: 9,
        ids: pageIds,
        ...(hasMore ? { nextAfter: pageIds.at(-1)! } : {}),
      });
    },
  } as unknown as SpaceState["manager"];
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec", {
    loadManager: () => Promise.resolve(manager),
  });
  bridge.init({ apiUrl: "https://example.invalid", identity: "test" });

  const state = await bridge.connectSpace("home");
  const entries = await openDirectorySnapshot(bridge, state.entitiesIno);

  assertEquals(entries.length, ids.length + 2);
  assertEquals(
    entries.slice(2).map(({ name }) => name),
    ids.map((id) => encodeFuseComponent(id)),
  );
  assertEquals(requests, [
    { limit: 1_000 },
    { after: ids[999], limit: 1_000, expectedServerSeq: 9 },
  ]);
  assertEquals(tree.getChildren(state.entitiesIno), []);
});

Deno.test("CellBridge exact entity lookup is targeted and projection cache is bounded", async () => {
  const ids = [
    "of:fid1:entity-0",
    "of:fid1:entity-1",
    "of:fid1:entity-2",
  ];
  let listRequests = 0;
  const existenceRequests: string[] = [];
  const manager = {
    getSpace: () => "did:key:zTargetedEntitySpace",
    listEntityIdPage: () => {
      listRequests++;
      return Promise.resolve({ serverSeq: 1, ids });
    },
    entityIdExists: (id: string) => {
      existenceRequests.push(id);
      return Promise.resolve(ids.includes(id));
    },
  } as unknown as SpaceState["manager"];
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec", {
    loadManager: () => Promise.resolve(manager),
    maxEntityProjections: 2,
  });
  bridge.init({ apiUrl: "https://example.invalid", identity: "test" });
  const state = await bridge.connectSpace("home");

  for (const id of [ids[0], ids[1], ids[0], ids[2]]) {
    assertEquals(
      await bridge.prepareLookup(
        state.entitiesIno,
        encodeFuseComponent(id),
      ),
      true,
    );
  }

  assertEquals(listRequests, 0);
  assertEquals(existenceRequests, [ids[0], ids[1], ids[0], ids[2]]);
  assertEquals(state.entityIds, new Set([ids[0], ids[2]]));
  assertEquals(
    tree.getChildren(state.entitiesIno).map(([name]) => name),
    [ids[0], ids[2]].map((id) => encodeFuseComponent(id)),
  );
});

Deno.test("CellBridge keeps a newly resolved projection while older hydration is pending", async () => {
  const firstId = "of:fid1:pending-entity";
  const secondId = "of:fid1:new-entity";
  const firstPiece = defer<unknown>();
  const hydrationStarted = defer<void>();
  const piece = (id: string) => ({
    id,
    name: () => id,
    getPatternRef: () => Promise.resolve(undefined),
    input: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
    result: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
  });
  const manager = {
    getSpace: () => "did:key:zPendingEntitySpace",
    entityIdExists: (id: string) =>
      Promise.resolve(id === firstId || id === secondId),
  } as unknown as SpaceState["manager"];
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec", {
    loadManager: () => Promise.resolve(manager),
    maxEntityProjections: 1,
  });
  bridge.init({ apiUrl: "https://example.invalid", identity: "test" });
  const state = await bridge.connectSpace("home");
  state.pieces = {
    get: (id: string) => {
      if (id === firstId) {
        hydrationStarted.resolve();
        return firstPiece.promise;
      }
      return Promise.resolve(piece(id));
    },
  } as unknown as SpaceState["pieces"];

  assertEquals(
    await bridge.prepareLookup(
      state.entitiesIno,
      encodeFuseComponent(firstId),
    ),
    true,
  );
  const firstIno = tree.lookup(
    state.entitiesIno,
    encodeFuseComponent(firstId),
  )!;
  const firstHydration = bridge.prepareLookup(firstIno, "meta.json");
  await hydrationStarted.promise;

  assertEquals(
    await bridge.prepareLookup(
      state.entitiesIno,
      encodeFuseComponent(secondId),
    ),
    true,
  );
  assertNotEquals(
    tree.lookup(state.entitiesIno, encodeFuseComponent(secondId)),
    undefined,
  );

  firstPiece.resolve(piece(firstId));
  await firstHydration;
  assertEquals(
    tree.lookup(state.entitiesIno, encodeFuseComponent(firstId)),
    undefined,
  );
  assertNotEquals(
    tree.lookup(state.entitiesIno, encodeFuseComponent(secondId)),
    undefined,
  );
});

Deno.test("CellBridge defers projection eviction until lookup and open references close", async () => {
  const ids = [
    "of:fid1:referenced-entity",
    "of:fid1:middle-entity",
    "of:fid1:latest-entity",
  ];
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec", {
    loadManager: () =>
      Promise.resolve(
        {
          getSpace: () => "did:key:zReferencedEntitySpace",
          entityIdExists: (id: string) => Promise.resolve(ids.includes(id)),
        } as unknown as SpaceState["manager"],
      ),
    maxEntityProjections: 1,
  });
  bridge.init({ apiUrl: "https://example.invalid", identity: "test" });
  const state = await bridge.connectSpace("home");

  await bridge.prepareLookup(state.entitiesIno, encodeFuseComponent(ids[0]));
  const firstIno = tree.lookup(
    state.entitiesIno,
    encodeFuseComponent(ids[0]),
  )!;
  bridge.retainEntityProjectionLookup(firstIno);
  bridge.retainEntityProjectionOpen(firstIno);

  await bridge.prepareLookup(state.entitiesIno, encodeFuseComponent(ids[1]));
  await bridge.prepareLookup(state.entitiesIno, encodeFuseComponent(ids[2]));
  const latestIno = tree.lookup(
    state.entitiesIno,
    encodeFuseComponent(ids[2]),
  )!;
  bridge.retainEntityProjectionLookup(latestIno);

  assertNotEquals(tree.getNode(firstIno), undefined);
  assertNotEquals(tree.getNode(latestIno), undefined);
  bridge.releaseEntityProjectionLookup(firstIno);
  assertNotEquals(tree.getNode(firstIno), undefined);
  bridge.releaseEntityProjectionOpen(firstIno);
  assertEquals(tree.getNode(firstIno), undefined);
  assertNotEquals(tree.getNode(latestIno), undefined);
  bridge.releaseEntityProjectionLookup(latestIno);
});

Deno.test("CellBridge removes an entity deleted during root hydration", async () => {
  const entityId = "of:fid1:deleted-during-hydration";
  let entityIds = [entityId];
  const pendingPiece = defer<unknown>();
  const hydrationStarted = defer<void>();
  const piece = {
    id: entityId,
    name: () => "Deleted Entity",
    getPatternRef: () => Promise.resolve(undefined),
    input: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
    result: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
  };
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const state = buildTestSpace(bridge, "home", []);
  state.manager = {
    listEntityIdPage: () =>
      Promise.resolve({ serverSeq: 1, ids: [...entityIds] }),
    entityIdExists: (id: string) => Promise.resolve(entityIds.includes(id)),
  } as unknown as SpaceState["manager"];
  state.pieces = {
    get: () => {
      hydrationStarted.resolve();
      return pendingPiece.promise;
    },
  } as unknown as SpaceState["pieces"];

  await openDirectorySnapshot(bridge, state.entitiesIno);
  await bridge.prepareLookup(
    state.entitiesIno,
    encodeFuseComponent(entityId),
  );
  const entityIno = tree.lookup(
    state.entitiesIno,
    encodeFuseComponent(entityId),
  )!;
  const hydration = bridge.prepareLookup(entityIno, "meta.json");
  await hydrationStarted.promise;

  entityIds = [];
  await openDirectorySnapshot(bridge, state.entitiesIno);
  assertEquals(
    tree.lookup(state.entitiesIno, encodeFuseComponent(entityId)),
    undefined,
  );
  assertNotEquals(tree.getNode(entityIno), undefined);

  pendingPiece.resolve(piece);
  assertEquals(await hydration, false);
  assertEquals(tree.getNode(entityIno), undefined);
});

Deno.test("CellBridge keeps hydrated entity-only projections current", async () => {
  const time = new FakeTime();
  try {
    const entityId = "of:fid1:entity-only-reactive";
    const resultCell = new SinkableCell({ content: "before" });
    const piece = {
      id: entityId,
      name: () => "Entity Only",
      getPatternRef: () => Promise.resolve(undefined),
      input: {
        getCell: () => Promise.resolve(makeCell({}, undefined)),
        get: () => Promise.resolve({}),
      },
      result: {
        getCell: () => Promise.resolve(resultCell as unknown as FakeCell),
        get: () => Promise.resolve(resultCell.get()),
      },
    };
    const tree = new FsTree();
    const bridge = new CellBridge(tree, "/tmp/cf-exec");
    const state = buildTestSpace(bridge, "home", []);
    state.manager = {
      entityIdExists: (id: string) => Promise.resolve(id === entityId),
    } as unknown as SpaceState["manager"];
    state.pieces = {
      get: () => Promise.resolve(piece),
    } as unknown as SpaceState["pieces"];

    await bridge.prepareLookup(
      state.entitiesIno,
      encodeFuseComponent(entityId),
    );
    const entityIno = tree.lookup(
      state.entitiesIno,
      encodeFuseComponent(entityId),
    )!;
    assertEquals(await bridge.prepareLookup(entityIno, "result"), true);
    const resultIno = tree.lookup(entityIno, "result")!;
    assertEquals(getFileContent(tree, resultIno, "content"), "before");

    resultCell.set({ content: "after" });
    await time.tickAsync(200);
    await time.runMicrotasks();
    assertEquals(getFileContent(tree, resultIno, "content"), "after");
  } finally {
    time.restore();
  }
});

Deno.test("CellBridge keeps a mounted space visible when identifier listing fails", async () => {
  const tree = new FsTree();
  const entityId = "of:fid1:retry-entity";
  let managerLoads = 0;
  let listRequests = 0;
  const bridge = new CellBridge(tree, "/tmp/cf-exec", {
    loadManager: () => {
      managerLoads++;
      return Promise.resolve(
        {
          getSpace: () => "did:key:zRetrySpace",
          listEntityIdPage: () => {
            listRequests++;
            return listRequests === 1
              ? Promise.reject(new Error("identifier list unavailable"))
              : Promise.resolve({ serverSeq: 1, ids: [entityId] });
          },
        } as unknown as SpaceState["manager"],
      );
    },
  });
  bridge.init({ apiUrl: "https://example.invalid", identity: "test" });

  const state = await bridge.connectSpace("home");
  assertEquals(
    tree.lookup(tree.rootIno, encodeFuseComponent("home")),
    state.spaceIno,
  );
  await assertRejects(
    () => openDirectorySnapshot(bridge, state.entitiesIno),
    Error,
    "identifier list unavailable",
  );
  assertEquals(bridge.isConnecting("home"), false);
  assertEquals(
    (await openDirectorySnapshot(bridge, state.entitiesIno)).slice(2).map(
      ({ name }) => name,
    ),
    [encodeFuseComponent(entityId)],
  );
  assertEquals(managerLoads, 1);
});

Deno.test("CellBridge connects before an entity directory snapshot finishes", async () => {
  const tree = new FsTree();
  const discoveryStarted = defer();
  const identifiers = defer<{ serverSeq: number; ids: string[] }>();
  const entityId = "of:fid1:delayed-entity";
  let managerLoads = 0;
  const manager = {
    getSpace: () => "did:key:zDelayedSpace",
    listEntityIdPage: () => {
      discoveryStarted.resolve();
      return identifiers.promise;
    },
  } as unknown as SpaceState["manager"];
  const bridge = new CellBridge(tree, "/tmp/cf-exec", {
    loadManager: () => {
      managerLoads++;
      return Promise.resolve(manager);
    },
  });
  bridge.init({ apiUrl: "https://example.invalid", identity: "test" });

  const firstState = await bridge.connectSpace("home");
  const listing = openDirectorySnapshot(bridge, firstState.entitiesIno);
  await discoveryStarted.promise;
  assertEquals(
    tree.lookup(tree.rootIno, encodeFuseComponent("home")),
    firstState.spaceIno,
  );

  const secondState = await bridge.connectSpace("home");
  assertEquals(managerLoads, 1);
  identifiers.resolve({ serverSeq: 1, ids: [entityId] });

  assertEquals(firstState.spaceIno, secondState.spaceIno);
  assertEquals(bridge.isConnecting("home"), false);
  assertEquals(
    (await listing).slice(2).map(({ name }) => name),
    [encodeFuseComponent(entityId)],
  );
});

Deno.test("CellBridge reconnect keeps an unmaterialized /pieces view identifier-only", async () => {
  const tree = new FsTree();
  let identifierRequests = 0;
  let pieceListRequests = 0;
  let disposedManagers = 0;
  const reconnectManager = {
    synced: () => Promise.resolve(),
    listEntityIdPage: () => {
      identifierRequests++;
      return Promise.resolve({
        serverSeq: 1,
        ids: ["of:fid1:reconnect-entity"],
      });
    },
    runtime: {
      dispose: () => {
        disposedManagers++;
        return Promise.resolve();
      },
    },
  } as unknown as SpaceState["manager"];
  const bridge = new CellBridge(tree, "/tmp/cf-exec", {
    loadManager: () => Promise.resolve(reconnectManager),
  });
  const state = buildTestSpace(bridge, "home", []);
  state.piecesHydrated = false;
  state.pieces = {
    getAllPieces: () => {
      pieceListRequests++;
      return Promise.resolve([]);
    },
  } as unknown as SpaceState["pieces"];

  const reconnectable = bridge as unknown as {
    _disconnected: boolean;
    _attemptReconnect(): Promise<void>;
  };
  reconnectable._disconnected = true;
  await reconnectable._attemptReconnect();

  assertEquals(reconnectable._disconnected, false);
  assertEquals(identifierRequests, 1);
  assertEquals(pieceListRequests, 0);
  assertEquals(disposedManagers, 1);
});

Deno.test("CellBridge status reports /pieces loaded only after materialization", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const state = buildTestSpace(bridge, "home", []);
  const pieces = defer<unknown[]>();
  state.piecesHydrated = false;
  state.piecesMaterializing = false;
  state.pieceListSubscribed = false;
  state.pieces = {
    getAllPieces: () => pieces.promise,
  } as unknown as SpaceState["pieces"];
  bridge.initStatus();

  const preparing = bridge.prepareDirectory(state.piecesIno);
  assertEquals(state.piecesMaterializing, true);
  assertEquals(
    JSON.parse(readStatusFile(tree)).spaces.home.piecesLoaded,
    false,
  );

  pieces.resolve([]);
  assertEquals(await preparing, true);
  assertEquals(state.piecesMaterializing, false);
  assertEquals(state.piecesHydrated, true);
  assertEquals(
    JSON.parse(readStatusFile(tree)).spaces.home.piecesLoaded,
    true,
  );
});

Deno.test("CellBridge real manager mount and /entities listing transfer only identifiers", async () => {
  const signer = await Identity.fromPassphrase(
    "fuse real manager identifier listing",
  );
  const session = await createSession({
    identity: signer,
    spaceDid: signer.did(),
  });
  const space = session.space;
  const rootId = `of:${space}`;
  const hiddenId = "of:fid1:fuse-real-manager-hidden";
  const rootPayload = "FUSE_ROOT_ENTITY_BYTES_0fb29de4".repeat(20);
  const hiddenPayload = "FUSE_HIDDEN_ENTITY_BYTES_6c6dfbec".repeat(20);
  const audience = "did:key:z6Mk-fuse-entity-list-test-audience";
  const server = new MemoryV2Server.Server({
    authorizeSessionOpen: () => signer.did(),
    sessionOpenAuth: { audience },
    store: new URL(`memory://fuse-entity-list-${crypto.randomUUID()}`),
  });
  const sessionOpenAuth: MemoryV2Client.SessionOpenAuthFactory = (
    _space,
    _session,
    context,
  ) => ({
    invocation: {
      aud: context.audience,
      challenge: context.challenge.value,
    },
    authorization: {},
  });
  const writerClient = await MemoryV2Client.connect({
    transport: MemoryV2Client.loopback(server),
  });
  let runtime: Runtime | undefined;

  try {
    const writer = await writerClient.mount(space, {}, sessionOpenAuth);
    await writer.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [
        {
          op: "set",
          id: rootId,
          value: { value: { payload: rootPayload } },
        },
        {
          op: "set",
          id: hiddenId,
          value: { value: { payload: hiddenPayload } },
        },
      ],
    });

    const serverPayloads: string[] = [];
    class RecordingSessionFactory implements SessionFactory {
      async create(spaceId: string, _signer?: Signer) {
        const inner = MemoryV2Client.loopback(server);
        const transport: MemoryV2Client.Transport = {
          send: (payload) => inner.send(payload),
          close: () => inner.close(),
          setReceiver: (receiver) => {
            inner.setReceiver((payload) => {
              serverPayloads.push(payload);
              receiver(payload);
            });
          },
          setCloseReceiver: (receiver) => {
            inner.setCloseReceiver?.(receiver);
          },
        };
        const client = await MemoryV2Client.connect({ transport });
        const mounted = await client.mount(spaceId, {}, sessionOpenAuth);
        return { client, session: mounted };
      }
    }
    class RecordingStorageManager extends V2StorageManager {
      constructor(as: Identity) {
        super(
          { as, memoryHost: new URL("memory://") } as V2StorageOptions,
          new RecordingSessionFactory(),
        );
      }

      override registerSpaceHost(): boolean {
        return false;
      }
    }

    const storageManager = new RecordingStorageManager(signer);
    runtime = new Runtime({
      apiUrl: new URL("https://example.invalid"),
      storageManager,
    });
    const manager = new PieceManager(session, runtime, {
      deferSpaceCellSync: true,
    });
    const tree = new FsTree();
    const bridge = new CellBridge(tree, "/tmp/cf-exec", {
      loadManager: () => Promise.resolve(manager),
    });
    bridge.init({ apiUrl: "https://example.invalid", identity: "test" });

    const state = await bridge.connectSpace("home");
    const entries = await openDirectorySnapshot(bridge, state.entitiesIno);
    const entryNames = new Set(entries.slice(2).map(({ name }) => name));
    assertEquals(entryNames.has(encodeFuseComponent(rootId)), true);
    assertEquals(entryNames.has(encodeFuseComponent(hiddenId)), true);
    assertEquals(tree.getChildren(state.entitiesIno), []);
    for (const { name } of entries.slice(2)) {
      assertEquals(await bridge.prepareLookup(state.entitiesIno, name), true);
      assertEquals(
        tree.getNode(tree.lookup(state.entitiesIno, name)!)?.kind,
        "dir",
      );
    }

    assertEquals(
      serverPayloads.some((payload) => payload.includes(rootPayload)),
      false,
    );
    assertEquals(
      serverPayloads.some((payload) => payload.includes(hiddenPayload)),
      false,
    );
    assertEquals(
      serverPayloads.some((payload) =>
        payload.includes(rootId) && payload.includes(hiddenId)
      ),
      true,
    );
    assertEquals(state.pieceMap.size, 0);
    assertEquals(state.pieceListSubscribed, false);
  } finally {
    await runtime?.dispose();
    await writerClient.close();
    await server.close();
  }
});

Deno.test("CellBridge materializes allPieces when /pieces is first read", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const piece = {
    id: "of:lazy-piece",
    name: () => "Lazy Piece",
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
  const state = buildTestSpace(bridge, "home", [piece]);
  state.allPieceIds = new Set([piece.id]);
  state.piecesHydrated = false;
  state.pieceListSubscribed = false;

  assertEquals(bridge.shouldPrepareDirectory(state.piecesIno), true);
  assertEquals(
    bridge.shouldPrepareLookup(state.piecesIno, "pieces.json"),
    true,
  );
  assertEquals(bridge.shouldSynchronizeLookup(state.piecesIno), true);
  assertEquals(tree.lookup(state.piecesIno, "Lazy-Piece"), undefined);

  assertEquals(
    await bridge.prepareLookup(state.piecesIno, "pieces.json"),
    true,
  );
  assertEquals(state.piecesHydrated, true);
  assertEquals(state.pieceListSubscribed, true);
  assertEquals(
    tree.lookup(state.piecesIno, "Lazy-Piece") !== undefined,
    true,
  );
});

Deno.test("CellBridge refreshes /entities from the complete identifier list", async () => {
  const tree = new FsTree();
  let entityIds = ["of:fid1:original"];
  const piecesCell = { sink: () => () => {} };
  const manager = {
    getSpace: () => "did:key:zEntityRefreshSpace",
    getPieces: () => Promise.resolve(piecesCell),
    syncPieces: () => Promise.resolve([]),
    listEntityIdPage: () =>
      Promise.resolve({ serverSeq: 1, ids: [...entityIds] }),
    entityIdExists: (id: string) => Promise.resolve(entityIds.includes(id)),
  } as unknown as SpaceState["manager"];
  const bridge = new CellBridge(tree, "/tmp/cf-exec", {
    loadManager: () => Promise.resolve(manager),
  });
  bridge.init({ apiUrl: "https://example.invalid", identity: "test" });
  const state = await bridge.connectSpace("home");

  assertEquals(
    (await openDirectorySnapshot(bridge, state.entitiesIno)).slice(2).map(
      ({ name }) => name,
    ),
    entityIds.map((id) => encodeFuseComponent(id)),
  );
  const originalName = encodeFuseComponent(entityIds[0]);
  assertEquals(
    await bridge.prepareLookup(state.entitiesIno, originalName),
    true,
  );

  entityIds = ["of:fid1:replacement"];
  assertEquals(
    (await openDirectorySnapshot(bridge, state.entitiesIno)).slice(2).map(
      ({ name }) => name,
    ),
    entityIds.map((id) => encodeFuseComponent(id)),
  );
  assertEquals(tree.lookup(state.entitiesIno, originalName), undefined);
});

Deno.test("CellBridge removes property indexes with a deleted entity", async () => {
  const tree = new FsTree();
  const entityId = "of:fid1:removed-entity";
  let entityIds = [entityId];
  const piece = {
    id: entityId,
    name: () => "Removed Entity",
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
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const state = buildTestSpace(bridge, "home", []);
  state.manager = {
    listEntityIdPage: () =>
      Promise.resolve({ serverSeq: 1, ids: [...entityIds] }),
    entityIdExists: (id: string) => Promise.resolve(entityIds.includes(id)),
  } as unknown as SpaceState["manager"];
  state.pieces = {
    get: () => Promise.resolve(piece),
  } as unknown as SpaceState["pieces"];

  await openDirectorySnapshot(bridge, state.entitiesIno);
  assertEquals(
    await bridge.prepareLookup(
      state.entitiesIno,
      encodeFuseComponent(entityId),
    ),
    true,
  );
  const entityIno = tree.lookup(
    state.entitiesIno,
    encodeFuseComponent(entityId),
  )!;
  assertEquals(await bridge.prepareLookup(entityIno, "input"), true);
  const inputIno = tree.lookup(entityIno, "input")!;
  const resultIno = tree.lookup(entityIno, "result")!;
  assertEquals(bridge.shouldPrepareDirectory(inputIno), true);
  assertEquals(bridge.shouldPrepareDirectory(resultIno), true);

  entityIds = [];
  await openDirectorySnapshot(bridge, state.entitiesIno);
  assertEquals(tree.getNode(inputIno), undefined);
  assertEquals(tree.getNode(resultIno), undefined);
  assertEquals(bridge.shouldPrepareDirectory(inputIno), false);
  assertEquals(bridge.shouldPrepareDirectory(resultIno), false);
});

Deno.test("CellBridge fails closed without paginated identifier listing", async () => {
  const tree = new FsTree();
  const entityId = "of:fid1:legacy-piece";
  let entityValueRequests = 0;
  const rejectEntityValueRequest = () => {
    entityValueRequests++;
    throw new Error("legacy fallback must not load the entity value");
  };
  const listedPieceCell = {
    entityId: { "/": entityId },
    asSchema() {
      return this;
    },
    get: rejectEntityValueRequest,
    getRaw: rejectEntityValueRequest,
    sync: rejectEntityValueRequest,
  };
  let pieceListRequests = 0;
  const manager = {
    getSpace: () => "did:key:zLegacyEntityListSpace",
    getPieces: () => {
      pieceListRequests++;
      return Promise.resolve({ sink: () => () => {} });
    },
    syncPieces: () => {
      pieceListRequests++;
      return Promise.resolve([listedPieceCell]);
    },
    listEntityIds: () => Promise.resolve(undefined),
    get: rejectEntityValueRequest,
  } as unknown as SpaceState["manager"];
  const bridge = new CellBridge(tree, "/tmp/cf-exec", {
    loadManager: () => Promise.resolve(manager),
  });
  bridge.init({ apiUrl: "https://example.invalid", identity: "test" });

  const state = await bridge.connectSpace("home");
  await assertRejects(
    () => openDirectorySnapshot(bridge, state.entitiesIno),
    Error,
    "does not support paginated entity identifier listing",
  );

  assertEquals(
    tree.getChildren(state.entitiesIno).map(([name]) => name),
    [],
  );
  assertEquals(entityValueRequests, 0);
  assertEquals(pieceListRequests, 0);
});

// ---------------------------------------------------------------------------
// Group 1: loadPieceTree — initial tree structure
// ---------------------------------------------------------------------------

Deno.test("CellBridge.loadPieceTree creates meta.json with a pattern reference", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");

  const piece = {
    id: "of:entity-123",
    name: () => "My Note",
    getPatternRef: () =>
      Promise.resolve({
        identity: "A".repeat(43),
        symbol: "default",
        source: {
          ref: `cf:pattern:${"A".repeat(43)}`,
          repository: "https://github.com/commontoolsinc/labs",
          entry: "/notes/note.tsx",
        },
      }),
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
  assertEquals(meta.patternRef, {
    identity: "A".repeat(43),
    symbol: "default",
    source: {
      ref: `cf:pattern:${"A".repeat(43)}`,
      repository: "https://github.com/commontoolsinc/labs",
      entry: "/notes/note.tsx",
    },
  });
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

Deno.test("CellBridge.rebuildPieceProp reuses a callable's inode across a rebuild", async () => {
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

  // The result directory and the callable inside it both still exist at the
  // same path with the same kind, so the rebuild adopts their inodes rather
  // than allocating new ones.
  const currentResultIno = tree.lookup(pieceIno, "result");
  assertEquals(currentResultIno, initialResultIno);
  const currentToolIno = tree.lookup(currentResultIno!, "search.tool");
  assertEquals(currentToolIno, initialToolIno);
  assertEquals(tree.getNode(currentToolIno!)?.kind, "callable");
});

Deno.test("CellBridge.rebuildPieceProp keeps inodes stable and invalidates only changed values", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const state = buildTestSpace(bridge, "home", []);

  const inputSchema = {
    type: "object",
    properties: { title: { type: "string" }, count: { type: "number" } },
  };
  const piece = {
    id: "of:stable-inode-piece",
    name: () => "Stable Piece",
    getPatternMeta: () => Promise.resolve({}),
    input: {
      getCell: () =>
        Promise.resolve(makeCell({ title: "before", count: 1 }, inputSchema)),
      get: () => Promise.resolve({ title: "before", count: 1 }),
    },
    result: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
  };

  state.pieceControllers.set(
    "Stable Piece",
    piece as unknown as SpaceState["pieceControllers"] extends
      Map<string, infer T> ? T : never,
  );
  const pieceIno = await (bridge as unknown as { loadPieceTree: LoadPieceTree })
    .loadPieceTree(piece, state.piecesIno, "Stable Piece", "home");
  state.pieceMap.set("Stable Piece", piece.id);
  state.pieceInos.set("Stable Piece", pieceIno);

  await (bridge as unknown as { hydratePieceProp: HydratePieceProp })
    .hydratePieceProp.call(bridge, pieceIno, "input");

  const inputIno = tree.lookup(pieceIno, "input")!;
  const titleIno = tree.lookup(inputIno, "title")!;
  const countIno = tree.lookup(inputIno, "count")!;

  const invalidatedInodes: bigint[] = [];
  bridge.onInvalidateInode = (ino) => invalidatedInodes.push(ino);

  await (bridge as unknown as { rebuildPieceProp: RebuildPieceProp })
    .rebuildPieceProp.call(bridge, {
      cell: makeCell({ title: "after", count: 1 }, inputSchema),
      newValue: { title: "after", count: 1 },
      pieceId: piece.id,
      pieceIno,
      pieceName: "Stable Piece",
      propName: "input",
      resolveLink: () => null,
      spaceName: "home",
    });

  // Same paths, same kinds: the inodes are reused, not reallocated.
  assertEquals(tree.lookup(pieceIno, "input"), inputIno);
  assertEquals(tree.lookup(inputIno, "title"), titleIno);
  assertEquals(tree.lookup(inputIno, "count"), countIno);
  assertEquals(getFileContent(tree, inputIno, "title"), "after");

  // Only the changed value's inode cache is dropped; the unchanged sibling is
  // left cached.
  assertEquals(invalidatedInodes.includes(titleIno), true);
  assertEquals(invalidatedInodes.includes(countIno), false);
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

Deno.test("CellBridge.rebuildPieceProp keeps the FS projection index inode stable across a rebuild", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const state = buildTestSpace(bridge, "home", []);

  const makeFsResult = (content: string) => ({
    $FS: { type: "text/markdown", content, frontmatter: { pinned: true } },
  });
  const resultCell = new SinkableCell(makeFsResult("Hello"));

  const piece = {
    id: "of:entity-stable-fs",
    name: () => "Stable FS Fixture",
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

  state.pieceControllers.set(
    "Stable FS Fixture",
    piece as unknown as SpaceState["pieceControllers"] extends
      Map<string, infer T> ? T : never,
  );
  const pieceIno = await (bridge as unknown as { loadPieceTree: LoadPieceTree })
    .loadPieceTree(piece, state.piecesIno, "Stable FS Fixture", "home");
  state.pieceMap.set("Stable FS Fixture", piece.id);
  state.pieceInos.set("Stable FS Fixture", pieceIno);

  await (bridge as unknown as { hydratePieceProp: HydratePieceProp })
    .hydratePieceProp.call(bridge, pieceIno, "result");

  const indexIno = tree.lookup(pieceIno, "index.md")!;
  assertEquals(indexIno !== undefined, true);
  assertEquals(
    getFileContent(tree, pieceIno, "index.md").includes("Hello"),
    true,
  );

  const invalidatedInodes: bigint[] = [];
  bridge.onInvalidateInode = (ino) => invalidatedInodes.push(ino);

  resultCell.set(makeFsResult("Goodbye"));
  await (bridge as unknown as { rebuildPieceProp: RebuildPieceProp })
    .rebuildPieceProp.call(bridge, {
      cell: resultCell as unknown as ReturnType<typeof makeCell>,
      newValue: resultCell.get(),
      pieceId: piece.id,
      pieceIno,
      pieceName: "Stable FS Fixture",
      propName: "result",
      resolveLink: () => null,
      spaceName: "home",
    });

  // The projection index survives with the same inode and updated content, and
  // its stale data cache is dropped.
  assertEquals(tree.lookup(pieceIno, "index.md"), indexIno);
  assertEquals(
    getFileContent(tree, pieceIno, "index.md").includes("Goodbye"),
    true,
  );
  assertEquals(invalidatedInodes.includes(indexIno), true);
});

Deno.test("CellBridge.rebuildPieceProp reconciles a prop changing from an object to a scalar", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const state = buildTestSpace(bridge, "home", []);

  const objectSchema = {
    type: "object",
    properties: { title: { type: "string" } },
  };
  const piece = {
    id: "of:object-to-scalar",
    name: () => "Object To Scalar",
    getPatternMeta: () => Promise.resolve({}),
    input: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
    result: {
      getCell: () => Promise.resolve(makeCell({ title: "x" }, objectSchema)),
      get: () => Promise.resolve({ title: "x" }),
    },
  };
  state.pieceControllers.set(
    "Object To Scalar",
    piece as unknown as SpaceState["pieceControllers"] extends
      Map<string, infer T> ? T : never,
  );
  const pieceIno = await (bridge as unknown as { loadPieceTree: LoadPieceTree })
    .loadPieceTree(piece, state.piecesIno, "Object To Scalar", "home");
  state.pieceMap.set("Object To Scalar", piece.id);
  state.pieceInos.set("Object To Scalar", pieceIno);

  await (bridge as unknown as { hydratePieceProp: HydratePieceProp })
    .hydratePieceProp.call(bridge, pieceIno, "result");
  assertEquals(tree.getNode(tree.lookup(pieceIno, "result")!)?.kind, "dir");
  assertEquals(tree.lookup(pieceIno, "result.json") !== undefined, true);

  // The result becomes a bare string: `result` changes kind from a directory
  // to a file (its inode is replaced), and its `.json` sibling disappears
  // because a scalar has no aggregate form.
  await (bridge as unknown as { rebuildPieceProp: RebuildPieceProp })
    .rebuildPieceProp.call(bridge, {
      cell: makeCell("y", undefined),
      newValue: "y",
      pieceId: piece.id,
      pieceIno,
      pieceName: "Object To Scalar",
      propName: "result",
      resolveLink: () => null,
      spaceName: "home",
    });

  const resultIno = tree.lookup(pieceIno, "result");
  assertEquals(tree.getNode(resultIno!)?.kind, "file");
  assertEquals(getFileContent(tree, pieceIno, "result"), "y");
  assertEquals(tree.lookup(pieceIno, "result.json"), undefined);
});

Deno.test("CellBridge.rebuildPieceProp invalidates the index dentry when an FS projection is removed", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const state = buildTestSpace(bridge, "home", []);

  const resultCell = new SinkableCell({
    $FS: { type: "text/markdown", content: "Hello", frontmatter: {} },
  });
  const piece = {
    id: "of:entity-fs-removed",
    name: () => "FS Removed Fixture",
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
  state.pieceControllers.set(
    "FS Removed Fixture",
    piece as unknown as SpaceState["pieceControllers"] extends
      Map<string, infer T> ? T : never,
  );
  const pieceIno = await (bridge as unknown as { loadPieceTree: LoadPieceTree })
    .loadPieceTree(piece, state.piecesIno, "FS Removed Fixture", "home");
  state.pieceMap.set("FS Removed Fixture", piece.id);
  state.pieceInos.set("FS Removed Fixture", pieceIno);

  await (bridge as unknown as { hydratePieceProp: HydratePieceProp })
    .hydratePieceProp.call(bridge, pieceIno, "result");
  assertEquals(tree.lookup(pieceIno, "index.md") !== undefined, true);

  const entryInvalidations: string[] = [];
  bridge.onInvalidate = (parent, names) => {
    if (parent === pieceIno) entryInvalidations.push(...names);
  };

  resultCell.set(null);
  await (bridge as unknown as { rebuildPieceProp: RebuildPieceProp })
    .rebuildPieceProp.call(bridge, {
      cell: resultCell as unknown as ReturnType<typeof makeCell>,
      newValue: null,
      pieceId: piece.id,
      pieceIno,
      pieceName: "FS Removed Fixture",
      propName: "result",
      resolveLink: () => null,
      spaceName: "home",
    });

  // The projection is gone from the tree, and its `index.md` dentry is
  // invalidated so a client drops the entry instead of resolving a freed inode.
  assertEquals(tree.lookup(pieceIno, "index.md"), undefined);
  assertEquals(entryInvalidations.includes("index.md"), true);
});

Deno.test("CellBridge.rebuildPieceProp advances the piece dir mtime only when its entries change", async () => {
  let clock = 1_000;
  const tree = new FsTree(() => clock);
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const state = buildTestSpace(bridge, "home", []);

  const resultSchema = {
    type: "object",
    properties: { title: { type: "string" }, count: { type: "number" } },
  };
  const piece = {
    id: "of:piece-dir-mtime",
    name: () => "Dir Mtime Fixture",
    getPatternMeta: () => Promise.resolve({}),
    input: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
    result: {
      getCell: () =>
        Promise.resolve(makeCell({ title: "a", count: 1 }, resultSchema)),
      get: () => Promise.resolve({ title: "a", count: 1 }),
    },
  };
  state.pieceControllers.set(
    "Dir Mtime Fixture",
    piece as unknown as SpaceState["pieceControllers"] extends
      Map<string, infer T> ? T : never,
  );
  const pieceIno = await (bridge as unknown as { loadPieceTree: LoadPieceTree })
    .loadPieceTree(piece, state.piecesIno, "Dir Mtime Fixture", "home");
  state.pieceMap.set("Dir Mtime Fixture", piece.id);
  state.pieceInos.set("Dir Mtime Fixture", pieceIno);

  await (bridge as unknown as { hydratePieceProp: HydratePieceProp })
    .hydratePieceProp.call(bridge, pieceIno, "result");
  const afterHydrate = tree.getNode(pieceIno)!.mtime;

  // A content-only rebuild leaves the piece directory's entry set unchanged, so
  // its mtime is preserved.
  clock = 2_000;
  await (bridge as unknown as { rebuildPieceProp: RebuildPieceProp })
    .rebuildPieceProp.call(bridge, {
      cell: makeCell({ title: "b", count: 1 }, resultSchema),
      newValue: { title: "b", count: 1 },
      pieceId: piece.id,
      pieceIno,
      pieceName: "Dir Mtime Fixture",
      propName: "result",
      resolveLink: () => null,
      spaceName: "home",
    });
  assertEquals(tree.getNode(pieceIno)!.mtime, afterHydrate);

  // Removing the result drops result/, result.json and .handlers from the piece
  // directory, so its mtime advances.
  clock = 3_000;
  await (bridge as unknown as { rebuildPieceProp: RebuildPieceProp })
    .rebuildPieceProp.call(bridge, {
      cell: makeCell(null, undefined),
      newValue: null,
      pieceId: piece.id,
      pieceIno,
      pieceName: "Dir Mtime Fixture",
      propName: "result",
      resolveLink: () => null,
      spaceName: "home",
    });
  assertEquals(tree.getNode(pieceIno)!.mtime, 3_000);
});

Deno.test("CellBridge.addPieceToSpace advances the pieces directory mtime", async () => {
  let clock = 1_000;
  const tree = new FsTree(() => clock);
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const state = buildTestSpace(bridge, "home", []);
  const beforeAdd = tree.getNode(state.piecesIno)!.mtime;

  const piece = {
    id: "of:added-piece",
    name: () => "Added Piece",
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
  clock = 5_000;
  await (bridge as unknown as { addPieceToSpace: AddPieceToSpace })
    .addPieceToSpace(state, piece, "home");

  // The pieces directory gained an entry, so its mtime advances past its value
  // at space construction.
  assertEquals(tree.getNode(state.piecesIno)!.mtime > beforeAdd, true);
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
    patternRef: {
      identity: "A".repeat(43),
      symbol: "default",
      source: {
        ref: `cf:pattern:${"A".repeat(43)}`,
        entry: "/alpha.tsx",
      },
    },
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
      patternRef: {
        identity: "A".repeat(43),
        symbol: "default",
        source: {
          ref: `cf:pattern:${"A".repeat(43)}`,
          entry: "/alpha.tsx",
        },
      },
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

Deno.test("CellBridge reactive rebuild keeps inodes stable across a cell change", async () => {
  const time = new FakeTime();
  try {
    const tree = new FsTree();
    const bridge = new CellBridge(tree, "/tmp/cf-exec");
    const state = buildTestSpace(bridge, "home", []);
    const resultCell = new SinkableCell({ title: "before", count: 1 });

    const piece = {
      id: "of:reactive-stable",
      name: () => "Reactive Stable",
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

    const pieceIno = tree.lookup(state.piecesIno, "Reactive-Stable")!;
    await (bridge as unknown as { hydratePieceProp: HydratePieceProp })
      .hydratePieceProp.call(bridge, pieceIno, "result");

    const resultIno = tree.lookup(pieceIno, "result")!;
    const titleIno = tree.lookup(resultIno, "title")!;
    const countIno = tree.lookup(resultIno, "count")!;

    // An external mutation flows through the cell.sink subscription and is
    // rebuilt after the debounce.
    resultCell.set({ title: "after", count: 1 });
    await time.tickAsync(200);
    await time.runMicrotasks();

    // The reactive rebuild reconciled the mounted tree in place instead of
    // tearing it down, so a client that cached these paths keeps their inodes.
    assertEquals(tree.lookup(pieceIno, "result"), resultIno);
    assertEquals(tree.lookup(resultIno, "title"), titleIno);
    assertEquals(tree.lookup(resultIno, "count"), countIno);
    assertEquals(getFileContent(tree, resultIno, "title"), "after");

    const subs = state.pieceSubs.get("Reactive-Stable");
    if (subs) { for (const cancel of subs) cancel(); }
  } finally {
    time.restore();
  }
});

Deno.test("CellBridge refreshes pattern references after an in-place swap", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const state = buildTestSpace(bridge, "home", []);
  const rootCell = new PatternIdentityCell();
  let patternRef = {
    identity: "A".repeat(43),
    symbol: "default",
    source: {
      ref: `cf:pattern:${"A".repeat(43)}`,
      repository: "https://github.com/commontoolsinc/labs",
      entry: "/notes/note.tsx",
    },
  };
  const piece = {
    id: "of:swapped-piece",
    name: () => "Swapped Piece",
    getCell: () => rootCell,
    getPatternRef: () => Promise.resolve(patternRef),
    input: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
    result: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({ summary: "current" }),
    },
  };

  const projectedName = await (bridge as unknown as {
    addPieceToSpace: AddPieceToSpace;
  }).addPieceToSpace(state, piece, "home");
  const entityName = encodeFuseComponent(piece.id);
  assertEquals(await bridge.resolveEntity(state.entitiesIno, entityName), true);
  const entityIno = tree.lookup(state.entitiesIno, entityName)!;
  assertEquals(await bridge.prepareLookup(entityIno, "meta.json"), true);
  (bridge as unknown as { updatePiecesJson: UpdatePiecesJson })
    .updatePiecesJson(
      state,
    );

  patternRef = {
    identity: "B".repeat(43),
    symbol: "default",
    source: {
      ref: `cf:pattern:${"B".repeat(43)}`,
      repository: "https://github.com/commontoolsinc/labs",
      entry: "/notes/note.tsx",
    },
  };
  const pieceIno = state.pieceInos.get(projectedName)!;
  const refreshed = defer();
  bridge.onInvalidate = (parentIno, names) => {
    if (parentIno === pieceIno && names.includes("meta.json")) {
      refreshed.resolve();
    }
  };
  rootCell.emit();
  await refreshed.promise;

  assertEquals(
    JSON.parse(getFileContent(tree, pieceIno, "meta.json")).patternRef,
    patternRef,
  );
  assertEquals(
    JSON.parse(getFileContent(tree, entityIno, "meta.json")).patternRef,
    patternRef,
  );
  const piecesJson = JSON.parse(
    getFileContent(tree, state.piecesIno, "pieces.json"),
  );
  assertEquals(piecesJson[0].patternRef, patternRef);

  patternRef = {
    ...patternRef,
    source: {
      ...patternRef.source,
      repository: "https://github.com/commontoolsinc/another-repo",
    },
  };
  const repositoryRefreshed = defer();
  bridge.onInvalidate = (parentIno, names) => {
    if (parentIno === pieceIno && names.includes("meta.json")) {
      repositoryRefreshed.resolve();
    }
  };
  rootCell.emit("patternRepository");
  await repositoryRefreshed.promise;
  assertEquals(
    JSON.parse(getFileContent(tree, pieceIno, "meta.json")).patternRef,
    patternRef,
  );

  const subs = state.pieceSubs.get(projectedName);
  if (subs) { for (const cancel of subs) cancel(); }
});

Deno.test("CellBridge pattern reference refresh fails closed", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const state = buildTestSpace(bridge, "home", []);
  const pieceIno = tree.addDir(state.piecesIno, "notes");
  let shouldReject = true;
  const piece = {
    id: "of:pattern-ref-failure",
    getPatternRef: () =>
      shouldReject
        ? Promise.reject(new Error("unavailable"))
        : Promise.resolve(undefined),
  };
  const refresh = (bridge as unknown as {
    refreshPiecePatternMetadata: RefreshPiecePatternMetadata;
  }).refreshPiecePatternMetadata.bind(bridge);

  await refresh(state, piece, pieceIno);
  shouldReject = false;
  await refresh(state, piece, pieceIno);

  assertEquals(state.pieceManifest.size, 0);
});

Deno.test("CellBridge reports pattern metadata subscription failures", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const state = buildTestSpace(bridge, "home", []);
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => errors.push(args.join(" "));

  const immediateRootCell = {
    asSchema: () => ({ sync: () => Promise.resolve() }),
    sinkMeta: (_key: string, sink: () => void) => {
      sink();
      return () => {};
    },
  };
  const piece = {
    id: "of:pattern-subscription-failure",
    name: () => "Pattern Subscription Failure",
    getCell: () => immediateRootCell,
    getPatternRef: () => Promise.resolve(undefined),
    getPatternMeta: () => Promise.resolve({}),
    getPatternSourceFiles: () => Promise.resolve([]),
    input: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
    result: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
  };
  (bridge as unknown as {
    refreshPiecePatternMetadata: RefreshPiecePatternMetadata;
  }).refreshPiecePatternMetadata = () =>
    Promise.reject(new Error("refresh failed"));

  try {
    await (bridge as unknown as { addPieceToSpace: AddPieceToSpace })
      .addPieceToSpace(state, piece, "home");
    await Promise.resolve();
  } finally {
    console.error = originalError;
  }

  assertEquals(errors.some((line) => line.includes("refresh failed")), true);
});

Deno.test("CellBridge reports pattern metadata setup failures", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const state = buildTestSpace(bridge, "home", []);
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  const piece = {
    id: "of:pattern-setup-failure",
    name: () => "Pattern Setup Failure",
    getCell: () => {
      throw new Error("root unavailable");
    },
    getPatternRef: () => Promise.resolve(undefined),
    getPatternMeta: () => Promise.resolve({}),
    getPatternSourceFiles: () => Promise.resolve([]),
    input: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
    result: {
      getCell: () => Promise.resolve(makeCell({}, undefined)),
      get: () => Promise.resolve({}),
    },
  };

  try {
    await (bridge as unknown as { addPieceToSpace: AddPieceToSpace })
      .addPieceToSpace(state, piece, "home");
  } finally {
    console.error = originalError;
  }

  assertEquals(
    errors.some((line) =>
      line.includes("Could not subscribe") && line.includes("root unavailable")
    ),
    true,
  );
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
    getPatternSourceFiles: () =>
      Promise.resolve([
        { name: "/src/has:colon.tsx", contents: "export default 1;" },
      ]),
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

Deno.test("CellBridge resolves a value file's write path after an in-place rebuild", () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const state = buildTestSpace(bridge, "did:key:zSpace", []);
  const piece = { id: "of:rebuilt-piece", name: () => "Rebuilt Piece" };
  state.pieceControllers.set("notes", piece as never);

  const pieceIno = tree.addDir(state.piecesIno, "notes");
  const inputIno = tree.addDir(pieceIno, "input", "object");
  const lastMessageIno = tree.addFile(inputIno, "lastMessage", "hi", "string");

  // A rebuild reconciles a freshly built staging subtree onto the live one, so
  // the value file survives the rebuild with the same inode. A write that
  // arrives on that cached inode still resolves to the same cell.
  const pendingIno = tree.addDir(pieceIno, ".input.pending", "object");
  tree.addFile(pendingIno, "lastMessage", "hello", "string");
  tree.transplantSubtree(inputIno, pendingIno);

  assertEquals(tree.lookup(inputIno, "lastMessage"), lastMessageIno);

  const writePath = bridge.resolveWritePath(lastMessageIno);
  assertEquals(writePath?.spaceName, "did:key:zSpace");
  assertEquals(writePath?.pieceName, "notes");
  assertEquals(writePath?.cell, "input");
  assertEquals(writePath?.jsonPath, ["lastMessage"]);
});

Deno.test("CellBridge decodes encoded space directory names for source write paths", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/cf-exec");
  const state = buildTestSpace(bridge, "did:key:zSource", []);
  const pieceIno = tree.addDir(state.piecesIno, "notes");
  let patternRefReads = 0;
  const piece = {
    id: "of:encoded-source-piece",
    getPatternRef: () => {
      patternRefReads++;
      return Promise.resolve({
        identity: "C".repeat(43),
        symbol: "default",
        source: { ref: `cf:pattern:${"C".repeat(43)}` },
      });
    },
    getPatternSourceFiles: () =>
      Promise.resolve([
        { name: "/src/main.ts", contents: "export default 1;" },
      ]),
  };
  state.pieceControllers.set("notes", piece as never);
  state.pieceInos.set("notes", pieceIno);
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

  await bridge.finalizeSourceWritePath(sourcePath!);
  assertEquals(patternRefReads, 1);
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

    const status = JSON.parse(readStatusFile(tree));
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

function makeStatusBridge(
  tree: FsTree,
  statusProvider: () => Record<string, unknown>,
): CellBridge {
  const bridge = new CellBridge(tree, "/tmp/cf-exec", { statusProvider });
  bridge.init({
    apiUrl: "http://localhost:8000",
    identity: "/tmp/test-identity.pem",
  });
  bridge.initStatus();
  return bridge;
}

Deno.test("CellBridge.status reports state that moved since the last read", () => {
  const tree = new FsTree();
  const writes = { opened: 0, written: 0, flushed: 0 };
  const bridge = makeStatusBridge(tree, () => ({ writes: { ...writes } }));

  const readStatus = () => JSON.parse(readStatusFile(tree));
  assertEquals(readStatus().writes, { opened: 0, written: 0, flushed: 0 });

  // The write path moves these counters and tells the bridge nothing. Each
  // read still has to see the counts as of that read.
  writes.opened++;
  assertEquals(readStatus().writes.opened, 1);

  writes.written += 2;
  writes.flushed++;
  assertEquals(readStatus().writes, { opened: 1, written: 2, flushed: 1 });

  bridge.setDebug(true);
  assertEquals(readStatus().debug, true);
});

Deno.test("CellBridge.status sizes .status from the bytes a read serves", () => {
  const tree = new FsTree();
  let diagnostics: string[] = [];
  makeStatusBridge(tree, () => ({ cfc: { diagnostics } }));

  const statusIno = tree.lookup(tree.rootIno, ".status")!;
  const sizeOf = () =>
    (tree.getNode(statusIno) as { content: Uint8Array }).content.length;
  const before = sizeOf();

  // State moving on its own must not move the size, which a reader has already
  // been given and will stop its read at.
  diagnostics = ["denied write to piece result"];
  assertEquals(sizeOf(), before);

  // Publishing moves the size and the bytes together.
  tree.refreshGenerated(statusIno);
  const after = sizeOf();
  assertEquals(after > before, true);
  assertEquals(after, getFileContent(tree, tree.rootIno, ".status").length);
});

Deno.test("CellBridge.status renders nothing when its state moves", () => {
  const tree = new FsTree();
  let renders = 0;
  const bridge = makeStatusBridge(tree, () => {
    renders++;
    return {};
  });

  // initStatus publishes once so the file has bytes before anyone reads it.
  assertEquals(renders, 1);

  // Rendering the document walks every space and its piece map. Nothing that
  // moves the state it reports should pay for that — the reader does.
  bridge.setDebug(true);
  bridge.markDisconnected("socket closed");
  assertEquals(renders, 1);
});

Deno.test("CellBridge.status renders when .status is read", () => {
  const tree = new FsTree();
  let renders = 0;
  const bridge = makeStatusBridge(tree, () => {
    renders++;
    return {};
  });
  bridge.setDebug(true);

  assertEquals(JSON.parse(readStatusFile(tree)).debug, true);
  assertEquals(renders, 2);
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
  assertEquals(await bridge.prepareLookup(entityIno, "result"), true);
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
