// Entity projection scaling benchmark. The scheduled benchmark workflow stores
// its operation timings and additional resource diagnostics.

import type { PieceManager } from "@commonfabric/piece";
import type {
  PieceController,
  PiecesController,
} from "@commonfabric/piece/ops";
import { CfcProjectionAnnotator } from "./annotations.ts";
import { CellBridge, type SpaceState } from "./cell-bridge.ts";
import {
  collectDirectorySnapshot,
  DirectoryHandleMap,
  type DirectorySnapshotEntry,
  FuseOperationState,
  prepareDirectoryForHandle,
} from "./directory-handles.ts";
import { encodeFuseComponent } from "./path-codec.ts";
import { FsTree } from "./tree.ts";

const encoder = new TextEncoder();
const PAGE_SIZE = 1_000;

interface FakeCell {
  schema: Record<string, unknown> | undefined;
  get(): unknown;
  getRaw(): unknown;
  asSchemaFromLinks(): FakeCell;
  key(segment: string): FakeCell;
}

interface ConnectedFixture {
  bridge: CellBridge;
  existenceRequests: () => number;
  ids: string[];
  listRequests: () => number;
  state: SpaceState;
  tree: FsTree;
  wireBytes: () => number;
}

interface Measurement {
  existenceRequests: number;
  heapMiB: number;
  inodes: number;
  listRequests: number;
  rssMiB: number;
  wallMs: number;
  wireMiB: number;
}

function entityIds(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) =>
      `of:baedreifakebenchmark${index.toString().padStart(32, "0")}`,
  );
}

function forceGc(): void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) return;
  for (let pass = 0; pass < 3; pass++) gc();
}

function mib(bytes: number): number {
  return Math.round(bytes / 104_857.6) / 10;
}

function diagnostic(
  label: string,
  invocation: number,
  value: object,
): void {
  const bytes = encoder.encode(`${
    JSON.stringify({
      label,
      invocation,
      phase: invocation === 0 ? "warmup" : "measured",
      ...value,
    })
  }\n`);
  const written = Deno.stderr.writeSync(bytes);
  if (written !== bytes.length) {
    throw new Error(`wrote ${written} of ${bytes.length} diagnostic bytes`);
  }
}

function firstIndexAfter(ids: readonly string[], after?: string): number {
  if (after === undefined) return 0;
  let low = 0;
  let high = ids.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (ids[middle] <= after) low = middle + 1;
    else high = middle;
  }
  return low;
}

async function connect(
  ids: string[],
  cfcAnnotations: boolean,
): Promise<ConnectedFixture> {
  let requests = 0;
  let lookups = 0;
  let transferredBytes = 0;
  const manager = {
    getSpace: () => "did:key:zFuseEntityProjectionBenchmark",
    listEntityIdPage: (options: {
      after?: string;
      limit?: number;
      expectedEntitySetSeq?: number;
    }) => {
      requests++;
      const start = firstIndexAfter(ids, options.after);
      const pageIds = ids.slice(start, start + (options.limit ?? PAGE_SIZE));
      const hasMore = start + pageIds.length < ids.length;
      const result = {
        serverSeq: 1,
        entitySetSeq: 1,
        ids: pageIds,
        ...(hasMore ? { nextAfter: pageIds.at(-1)! } : {}),
      };
      transferredBytes += encoder.encode(JSON.stringify(result)).length;
      return Promise.resolve(result);
    },
    entityIdExists: (id: string) => {
      lookups++;
      const index = firstIndexAfter(ids, id);
      const exists = index > 0 && ids[index - 1] === id;
      transferredBytes += encoder.encode(JSON.stringify({ exists })).length;
      return Promise.resolve(exists);
    },
    runtime: { dispose: () => Promise.resolve() },
  } as unknown as PieceManager;
  const tree = new FsTree(() => 0);
  const bridge = new CellBridge(tree, "", {
    cfcAnnotations,
    projectionGeneration: "entity-projection-review",
    loadManager: () => Promise.resolve(manager),
  });
  bridge.init({ apiUrl: "https://example.invalid", identity: "benchmark" });
  const state = await bridge.connectSpace("home");
  return {
    bridge,
    existenceRequests: () => lookups,
    ids,
    listRequests: () => requests,
    state,
    tree,
    wireBytes: () => transferredBytes,
  };
}

async function measureOperation<T>(
  benchmark: Deno.BenchContext,
  operation: () => Promise<T>,
): Promise<{ value: T; wallMs: number }> {
  const started = performance.now();
  benchmark.start();
  try {
    const value = await operation();
    return { value, wallMs: performance.now() - started };
  } finally {
    benchmark.end();
  }
}

async function measureConstruction(
  benchmark: Deno.BenchContext,
  ids: string[],
  cfcAnnotations: boolean,
): Promise<Measurement> {
  forceGc();
  const before = Deno.memoryUsage();
  const { value: fixture, wallMs } = await measureOperation(
    benchmark,
    async () => {
      const connected = await connect(ids, cfcAnnotations);
      for (const id of ids) {
        await connected.bridge.prepareLookup(
          connected.state.entitiesIno,
          encodeFuseComponent(id),
        );
      }
      return connected;
    },
  );
  forceGc();
  const after = Deno.memoryUsage();
  const expectedProjections = Math.min(ids.length, 128);
  if (
    fixture.state.entityIds.size !== expectedProjections ||
    fixture.listRequests() !== 0 ||
    fixture.existenceRequests() !== ids.length
  ) {
    throw new Error("targeted lookup did not keep a bounded projection cache");
  }
  return {
    existenceRequests: fixture.existenceRequests(),
    heapMiB: mib(after.heapUsed - before.heapUsed),
    inodes: fixture.tree.inodes.size,
    listRequests: fixture.listRequests(),
    rssMiB: mib(after.rss - before.rss),
    wallMs: Math.round(wallMs * 10) / 10,
    wireMiB: mib(fixture.wireBytes()),
  };
}

async function createEntityDirectorySnapshot(
  fixture: ConnectedFixture,
  handles: DirectoryHandleMap,
  fh: bigint,
): Promise<readonly DirectorySnapshotEntry[]> {
  const inode = fixture.state.entitiesIno;
  const prepared = await prepareDirectoryForHandle(
    handles,
    fh,
    inode,
    fixture.bridge,
  );
  return prepared ?? handles.snapshot(
    fh,
    inode,
    () => collectDirectorySnapshot(fixture.tree, inode),
  );
}

async function measureDirectoryOpen(
  benchmark: Deno.BenchContext,
  ids: string[],
): Promise<Measurement & { entries: number }> {
  const fixture = await connect(ids, false);
  const handles = new DirectoryHandleMap();
  const fh = handles.open(fixture.state.entitiesIno);
  forceGc();
  const before = Deno.memoryUsage();
  const { value: entries, wallMs } = await measureOperation(
    benchmark,
    () => createEntityDirectorySnapshot(fixture, handles, fh),
  );
  forceGc();
  const after = Deno.memoryUsage();
  if (entries.length !== ids.length + 2) {
    throw new Error("entity directory snapshot omitted identifiers");
  }
  if (handles.snapshot(fh, fixture.state.entitiesIno, () => []) !== entries) {
    throw new Error("directory handle did not retain its entry snapshot");
  }
  return {
    entries: entries.length,
    existenceRequests: fixture.existenceRequests(),
    heapMiB: mib(after.heapUsed - before.heapUsed),
    inodes: fixture.tree.inodes.size,
    listRequests: fixture.listRequests(),
    rssMiB: mib(after.rss - before.rss),
    wallMs: Math.round(wallMs * 10) / 10,
    wireMiB: mib(fixture.wireBytes()),
  };
}

async function measureLookupLifecycle(
  benchmark: Deno.BenchContext,
  ids: string[],
  forgetImmediately: boolean,
): Promise<Measurement & { retainedProjections: number }> {
  const fixture = await connect(ids, false);
  const operations = new FuseOperationState(fixture.tree, fixture.bridge);
  forceGc();
  const before = Deno.memoryUsage();
  const { wallMs } = await measureOperation(benchmark, async () => {
    for (const id of ids) {
      const ino = await operations.prepareLookup(
        fixture.state.entitiesIno,
        encodeFuseComponent(id),
      );
      if (ino === undefined) throw new Error(`lookup failed for ${id}`);
      if (forgetImmediately) operations.forget(ino, 1n);
    }
  });
  forceGc();
  const after = Deno.memoryUsage();
  const expectedProjections = forgetImmediately
    ? Math.min(ids.length, 128)
    : ids.length;
  if (fixture.state.entityIds.size !== expectedProjections) {
    throw new Error(
      `expected ${expectedProjections} retained projections, got ${fixture.state.entityIds.size}`,
    );
  }
  return {
    existenceRequests: fixture.existenceRequests(),
    heapMiB: mib(after.heapUsed - before.heapUsed),
    inodes: fixture.tree.inodes.size,
    listRequests: fixture.listRequests(),
    retainedProjections: fixture.state.entityIds.size,
    rssMiB: mib(after.rss - before.rss),
    wallMs: Math.round(wallMs * 10) / 10,
    wireMiB: mib(fixture.wireBytes()),
  };
}

async function measureConcurrentDirectoryOpens(
  benchmark: Deno.BenchContext,
  ids: string[],
  handleCount: number,
): Promise<Measurement & { entries: number; handles: number }> {
  const fixture = await connect(ids, false);
  const handles = new DirectoryHandleMap();
  const fileHandles = Array.from(
    { length: handleCount },
    () => handles.open(fixture.state.entitiesIno),
  );
  forceGc();
  const before = Deno.memoryUsage();
  const { value: snapshots, wallMs } = await measureOperation(
    benchmark,
    () =>
      Promise.all(
        fileHandles.map((fh) =>
          createEntityDirectorySnapshot(fixture, handles, fh)
        ),
      ),
  );
  forceGc();
  const after = Deno.memoryUsage();
  const first = snapshots[0];
  if (
    first === undefined ||
    first.length !== ids.length + 2 ||
    snapshots.some((snapshot) => snapshot !== first)
  ) {
    throw new Error("concurrent handles did not share one complete snapshot");
  }
  const expectedRequests = Math.max(1, Math.ceil(ids.length / PAGE_SIZE));
  if (fixture.listRequests() !== expectedRequests) {
    throw new Error(
      `expected ${expectedRequests} coalesced list requests, got ${fixture.listRequests()}`,
    );
  }
  return {
    entries: first.length,
    existenceRequests: fixture.existenceRequests(),
    handles: handleCount,
    heapMiB: mib(after.heapUsed - before.heapUsed),
    inodes: fixture.tree.inodes.size,
    listRequests: fixture.listRequests(),
    rssMiB: mib(after.rss - before.rss),
    wallMs: Math.round(wallMs * 10) / 10,
    wireMiB: mib(fixture.wireBytes()),
  };
}

for (const count of [1_000, 10_000, 100_000]) {
  let invocation = 0;
  Deno.bench({
    name: `exact-lookups-${count}`,
    group: "entity projection exact lookup cfc off",
    n: 1,
    fn: async (benchmark) => {
      diagnostic(
        `construction-cfc-off-${count}`,
        invocation++,
        await measureConstruction(benchmark, entityIds(count), false),
      );
    },
  });
}

for (const count of [1_000, 5_000, 10_000, 20_000]) {
  let invocation = 0;
  Deno.bench({
    name: `exact-lookups-${count}`,
    group: "entity projection exact lookup cfc on",
    n: 1,
    fn: async (benchmark) => {
      diagnostic(
        `construction-cfc-on-${count}`,
        invocation++,
        await measureConstruction(benchmark, entityIds(count), true),
      );
    },
  });
}

for (const count of [1_000, 10_000, 100_000]) {
  for (const forgetImmediately of [false, true]) {
    let invocation = 0;
    const lifecycle = forgetImmediately ? "forgotten" : "retained";
    Deno.bench({
      name: `${lifecycle}-${count}`,
      group: "entity projection kernel lookup lifecycle",
      n: 1,
      fn: async (benchmark) => {
        diagnostic(
          `kernel-lookups-${lifecycle}-${count}`,
          invocation++,
          await measureLookupLifecycle(
            benchmark,
            entityIds(count),
            forgetImmediately,
          ),
        );
      },
    });
  }
}

for (const count of [1_000, 10_000, 100_000]) {
  let invocation = 0;
  Deno.bench({
    name: `ids-${count}`,
    group: "entity projection directory open",
    n: 1,
    fn: async (benchmark) => {
      diagnostic(
        `directory-open-${count}`,
        invocation++,
        await measureDirectoryOpen(benchmark, entityIds(count)),
      );
    },
  });
}

for (const count of [10_000, 100_000]) {
  for (const handles of [1, 10, 100]) {
    let invocation = 0;
    Deno.bench({
      name: `${count}-ids-${handles}-handles`,
      group: "entity projection concurrent directory opens",
      n: 1,
      fn: async (benchmark) => {
        diagnostic(
          `directory-open-concurrent-${count}-${handles}`,
          invocation++,
          await measureConcurrentDirectoryOpens(
            benchmark,
            entityIds(count),
            handles,
          ),
        );
      },
    });
  }
}

for (
  const { count, refreshes } of [
    { count: 10_000, refreshes: 10 },
    { count: 100_000, refreshes: 3 },
  ]
) {
  let invocation = 0;
  Deno.bench({
    name: `${count}-ids-${refreshes}-refreshes`,
    group: "entity projection refresh",
    n: 1,
    fn: async (benchmark) => {
      const fixture = await connect(entityIds(count), false);
      forceGc();
      const before = Deno.memoryUsage();
      const { wallMs } = await measureOperation(benchmark, async () => {
        for (let iteration = 0; iteration < refreshes; iteration++) {
          await fixture.bridge.prepareDirectorySnapshot(
            fixture.state.entitiesIno,
          );
        }
      });
      forceGc();
      const after = Deno.memoryUsage();
      diagnostic(`refresh-${count}-${refreshes}`, invocation++, {
        heapMiB: mib(after.heapUsed - before.heapUsed),
        listRequests: fixture.listRequests(),
        rssMiB: mib(after.rss - before.rss),
        wallMs: Math.round(wallMs * 10) / 10,
        wireMiB: mib(fixture.wireBytes()),
      });
    },
  });
}

function fakeCell(value: unknown): FakeCell {
  return {
    schema: undefined,
    get: () => value,
    getRaw: () => value,
    asSchemaFromLinks() {
      return this;
    },
    key: () => fakeCell(undefined),
  };
}

let hydrationInvocation = 0;
Deno.bench({
  name: "1000-entity-recursive-walk",
  group: "entity projection hydration",
  n: 1,
  fn: async (benchmark) => {
    const count = 1_000;
    const fixture = await connect(entityIds(count), false);
    let entityGets = 0;
    let inputGets = 0;
    let resultGets = 0;
    const payload = {
      metadata: { title: "benchmark", tags: ["one", "two", "three"] },
      records: Array.from(
        { length: 10 },
        (_, index) => ({ index, text: "x".repeat(128) }),
      ),
    };

    fixture.state.pieces = {
      get: (id: string) => {
        entityGets++;
        const inputCell = fakeCell(payload);
        const resultCell = fakeCell(payload);
        return Promise.resolve({
          id,
          name: () => "",
          getPatternRef: () => Promise.resolve(undefined),
          input: {
            getCell: () => Promise.resolve(inputCell),
            get: () => {
              inputGets++;
              return Promise.resolve(payload);
            },
          },
          result: {
            getCell: () => Promise.resolve(resultCell),
            get: () => {
              resultGets++;
              return Promise.resolve(payload);
            },
          },
        } as unknown as PieceController);
      },
    } as unknown as PiecesController;

    forceGc();
    const before = Deno.memoryUsage();
    const { wallMs } = await measureOperation(benchmark, async () => {
      const entries = await fixture.bridge.prepareDirectorySnapshot(
        fixture.state.entitiesIno,
      );
      for (const { name } of entries?.slice(2) ?? []) {
        await fixture.bridge.prepareLookup(fixture.state.entitiesIno, name);
        const ino = fixture.tree.lookup(fixture.state.entitiesIno, name)!;
        await fixture.bridge.prepareDirectorySnapshot(ino);
      }
    });
    forceGc();
    const after = Deno.memoryUsage();
    if (entityGets !== 0 || inputGets !== 0 || resultGets !== 0) {
      throw new Error("recursive directory walk hydrated entity values");
    }
    diagnostic("recursive-hydration-1000", hydrationInvocation++, {
      entityGets,
      existenceRequests: fixture.existenceRequests(),
      heapMiB: mib(after.heapUsed - before.heapUsed),
      inodes: fixture.tree.inodes.size,
      inputGets,
      listRequests: fixture.listRequests(),
      resultGets,
      rssMiB: mib(after.rss - before.rss),
      wallMs: Math.round(wallMs * 10) / 10,
    });
  },
});

for (const count of [1_000, 5_000, 10_000]) {
  let invocation = 0;
  Deno.bench({
    name: `entries-${count}`,
    group: "CFC directory annotation batching",
    n: 1,
    fn: async (benchmark) => {
      const tree = new FsTree(() => 0);
      const parentIno = tree.addDir(tree.rootIno, "entities");
      const annotator = new CfcProjectionAnnotator(tree, {
        space: "did:key:zFuseEntityProjectionBenchmark",
        generation: "entity-projection-review",
        labelView: { version: 1, entries: [] },
      });
      annotator.annotateJsonDirectory(parentIno, [], {});
      forceGc();
      const before = Deno.memoryUsage();
      const { wallMs } = await measureOperation(benchmark, () => {
        for (let index = 0; index < count; index++) {
          const name = `entity-${index.toString().padStart(8, "0")}`;
          const childIno = tree.addDir(parentIno, name);
          annotator.annotateJsonDirectory(childIno, [name], {});
          annotator.annotateEntry(parentIno, name, childIno);
        }
        tree.getCfcAnnotation(parentIno);
        return Promise.resolve();
      });
      forceGc();
      const after = Deno.memoryUsage();
      diagnostic(`cfc-entry-batch-${count}`, invocation++, {
        heapMiB: mib(after.heapUsed - before.heapUsed),
        inodes: tree.inodes.size,
        rssMiB: mib(after.rss - before.rss),
        wallMs: Math.round(wallMs * 10) / 10,
      });
    },
  });
}
