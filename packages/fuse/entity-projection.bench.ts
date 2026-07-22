// Entity projection scaling benchmark. The scheduled benchmark workflow stores
// its operation timings and additional resource diagnostics.

import type { PieceManager } from "@commonfabric/piece";
import type {
  PieceController,
  PiecesController,
} from "@commonfabric/piece/ops";
import { CellBridge, type SpaceState } from "./cell-bridge.ts";
import { FsTree } from "./tree.ts";

const encoder = new TextEncoder();

interface FakeCell {
  schema: Record<string, unknown> | undefined;
  get(): unknown;
  getRaw(): unknown;
  asSchemaFromLinks(): FakeCell;
  key(segment: string): FakeCell;
}

interface ConnectedFixture {
  bridge: CellBridge;
  ids: string[];
  listRequests: () => number;
  state: SpaceState;
  tree: FsTree;
}

interface Measurement {
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

function diagnostic(label: string, value: object): void {
  // The JSON reporter captures console output from benchmark bodies. Direct
  // stderr writes remain available to the workflow's diagnostics artifact.
  const bytes = encoder.encode(`${JSON.stringify({ label, ...value })}\n`);
  const written = Deno.stderr.writeSync(bytes);
  if (written !== bytes.length) {
    throw new Error(`wrote ${written} of ${bytes.length} diagnostic bytes`);
  }
}

async function connect(
  ids: string[],
  cfcAnnotations: boolean,
): Promise<ConnectedFixture> {
  let requests = 0;
  const manager = {
    getSpace: () => "did:key:zFuseEntityProjectionBenchmark",
    listEntityIds: () => {
      requests++;
      return Promise.resolve(ids.slice());
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
    ids,
    listRequests: () => requests,
    state,
    tree,
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
    () => connect(ids, cfcAnnotations),
  );
  forceGc();
  const after = Deno.memoryUsage();
  const measurement = {
    heapMiB: mib(after.heapUsed - before.heapUsed),
    inodes: fixture.tree.inodes.size,
    listRequests: fixture.listRequests(),
    rssMiB: mib(after.rss - before.rss),
    wallMs: Math.round(wallMs * 10) / 10,
    wireMiB: mib(encoder.encode(JSON.stringify({ ids: fixture.ids })).length),
  };
  // Keep the fixture live through the post-construction memory snapshot.
  if (fixture.state.entityIds.size !== ids.length) {
    throw new Error("entity projection did not retain every ID");
  }
  return measurement;
}

for (const count of [1_000, 10_000, 100_000]) {
  Deno.bench({
    name: `stubs-${count}`,
    group: "entity projection cfc off",
    n: 1,
    fn: async (benchmark) => {
      const ids = entityIds(count);
      diagnostic(
        `construction-cfc-off-${count}`,
        await measureConstruction(benchmark, ids, false),
      );
    },
  });
}

for (const count of [1_000, 5_000, 10_000, 20_000]) {
  Deno.bench({
    name: `stubs-${count}`,
    group: "entity projection cfc on",
    n: 1,
    fn: async (benchmark) => {
      const ids = entityIds(count);
      diagnostic(
        `construction-cfc-on-${count}`,
        await measureConstruction(benchmark, ids, true),
      );
    },
  });
}

for (
  const { count, refreshes } of [
    { count: 10_000, refreshes: 10 },
    { count: 100_000, refreshes: 3 },
  ]
) {
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
          await fixture.bridge.prepareDirectory(fixture.state.entitiesIno);
        }
      });
      forceGc();
      const after = Deno.memoryUsage();
      diagnostic(`refresh-${count}-${refreshes}`, {
        heapMiB: mib(after.heapUsed - before.heapUsed),
        listRequests: fixture.listRequests(),
        rssMiB: mib(after.rss - before.rss),
        wallMs: Math.round(wallMs * 10) / 10,
        wireMiBPerRequest: mib(
          encoder.encode(JSON.stringify({ ids: fixture.ids })).length,
        ),
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
      for (
        const [, ino] of fixture.tree.getChildren(fixture.state.entitiesIno)
      ) {
        await fixture.bridge.prepareDirectory(ino);
      }
    });
    forceGc();
    const after = Deno.memoryUsage();
    diagnostic("recursive-hydration-1000", {
      entityGets,
      heapMiB: mib(after.heapUsed - before.heapUsed),
      inodes: fixture.tree.inodes.size,
      inputGets,
      resultGets,
      rssMiB: mib(after.rss - before.rss),
      sourcePayloadMiB: mib(
        encoder.encode(JSON.stringify(payload)).length * count * 2,
      ),
      wallMs: Math.round(wallMs * 10) / 10,
    });
  },
});
