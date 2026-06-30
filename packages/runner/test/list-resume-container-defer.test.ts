import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { Signer } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import type { Cell } from "../src/cell.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import {
  TEST_MEMORY_SERVER_AUTH,
  testPrincipalSessionOpenAuthFactory,
} from "./memory-v2-test-utils.ts";

// Container-defer guard for the list builtins (filter / flatMap / map).
//
// On a cold resume the coordinator reconcile for one of these builtins reads its
// result container. The reconcile runs after the resume pre-sync settles, so a
// container that was persisted in a prior runtime is loaded before the reconcile
// reads it. The defer guard handles the other case: a container that has no
// durable document at all. Reading it returns undefined, and rather than
// reconcile against that absent value (which would write a stale-basis result
// that conflicts on commit and re-runs in a loop), the builtin pulls the
// container and defers. Once the pull settles and the container is still absent,
// the builtin seeds an empty array so the coordinator is not wedged waiting for
// a value that will never arrive. The per-element results then re-trigger the
// reconcile, which rebuilds the aggregate against the confirmed per-element
// values.
//
// This drives that path deterministically. A first runtime builds and persists
// the durable aggregate, and its result container's document id is resolved from
// the result cell. A second (resuming) runtime uses a loopback transport that
// removes that one document from every resume sync, modeling a container that was
// never persisted. Everything else — the input list and the per-element result
// docs — still loads, so the builtin recovers the aggregate from the per-element
// values after seeding the empty container. The test asserts convergence to the
// correct aggregate.

const signer = await Identity.fromPassphrase("list resume container defer");
const space = signer.did();

// Doc ids withheld from the resuming runtime's syncs. Populated from runtime A
// once the container cell is resolved.
const droppedDocIds = new Set<string>();

// Rewrite a sync payload, removing any upsert for a withheld doc id. Payloads
// are `<prefix>:<json>`; anything that does not parse or carries no matching
// upsert passes through untouched.
function stripDroppedUpserts(payload: string): {
  payload: string;
  removed: number;
} {
  if (!payload.includes('"upserts"')) return { payload, removed: 0 };
  let matches = false;
  for (const id of droppedDocIds) {
    if (payload.includes(id)) {
      matches = true;
      break;
    }
  }
  if (!matches) return { payload, removed: 0 };
  const colon = payload.indexOf(":");
  if (colon < 0) return { payload, removed: 0 };
  const prefix = payload.slice(0, colon + 1);
  let obj: any;
  try {
    obj = JSON.parse(payload.slice(colon + 1));
  } catch {
    return { payload, removed: 0 };
  }
  const sync = obj?.ok?.sync ?? obj?.effect;
  if (!sync || !Array.isArray(sync.upserts)) return { payload, removed: 0 };
  const before = sync.upserts.length;
  sync.upserts = sync.upserts.filter(
    (u: any) => !droppedDocIds.has(String(u?.id)),
  );
  const removed = before - sync.upserts.length;
  if (removed === 0) return { payload, removed: 0 };
  return { payload: prefix + JSON.stringify(obj), removed };
}

function droppingLoopback(
  server: MemoryV2Server.Server,
  active: () => boolean,
  onRemove: (n: number) => void,
): MemoryV2Client.Transport {
  const inner = MemoryV2Client.loopback(server);
  return {
    send: (p: string) => inner.send(p),
    close: () => inner.close(),
    setReceiver: (r: (p: string) => void) => {
      inner.setReceiver((payload: string) => {
        if (active()) {
          const { payload: rewritten, removed } = stripDroppedUpserts(payload);
          if (removed > 0) {
            onRemove(removed);
            r(rewritten);
            return;
          }
        }
        r(payload);
      });
    },
    setCloseReceiver: (r: (e?: Error) => void) => inner.setCloseReceiver?.(r),
  };
}

class DroppingSessionFactory implements SessionFactory {
  constructor(
    private readonly getServer: () => MemoryV2Server.Server,
    private readonly active: () => boolean,
    private readonly onRemove: (n: number) => void,
  ) {}
  async create(spaceId: string, sgnr?: Signer) {
    const client = await MemoryV2Client.connect({
      transport: droppingLoopback(this.getServer(), this.active, this.onRemove),
    });
    const session = await client.mount(
      spaceId,
      {},
      testPrincipalSessionOpenAuthFactory(sgnr),
    );
    return { client, session };
  }
}

class DroppingStorageManager extends StorageManager {
  static make(
    as: Identity,
    server: MemoryV2Server.Server,
    active: () => boolean,
    onRemove: (n: number) => void = () => {},
  ): DroppingStorageManager {
    return new DroppingStorageManager(
      { as, memoryHost: new URL("memory://") } as Options,
      server,
      active,
      onRemove,
    );
  }
  private constructor(
    options: Options,
    server: MemoryV2Server.Server,
    active: () => boolean,
    onRemove: (n: number) => void,
  ) {
    super(
      options,
      new DroppingSessionFactory(() => server, active, onRemove),
    );
  }
  override registerSpaceHost(): boolean {
    return false;
  }
}

const FILTER_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ items: { keep: boolean; label: string }[] }>(({ items }) => {",
      "  return { kept: items.filter((item) => item.keep) };",
      "});",
    ].join("\n"),
  }],
};

const FLATMAP_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ items: { keep: boolean; n: number }[] }>(({ items }) => {",
      "  return { values: items.flatMap((item) => item.keep ? item.n : undefined) };",
      "});",
    ].join("\n"),
  }],
};

const MAP_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ items: { n: number }[] }>(({ items }) => {",
      "  return { doubled: items.map((item) => item.n * 2) };",
      "});",
    ].join("\n"),
  }],
};

const FILTER_ITEMS = [
  { keep: true, label: "a" },
  { keep: true, label: "b" },
  { keep: false, label: "c" },
  { keep: true, label: "d" },
];
const FLATMAP_ITEMS = [
  { keep: true, n: 1 },
  { keep: false, n: 2 },
  { keep: true, n: 3 },
  { keep: true, n: 4 },
];
const MAP_ITEMS = [{ n: 1 }, { n: 2 }, { n: 3 }];

describe("list builtin resume container defer", () => {
  let server: MemoryV2Server.Server;
  let sm1: DroppingStorageManager;
  let sm2: DroppingStorageManager;
  let dropActive: boolean;
  let removed: number;

  beforeEach(() => {
    dropActive = false;
    removed = 0;
    droppedDocIds.clear();
    server = new MemoryV2Server.Server({
      authorizeSessionOpen(message) {
        const principal = (message.authorization as { principal?: unknown })
          ?.principal;
        return typeof principal === "string" ? principal : undefined;
      },
      sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
    });
    sm1 = DroppingStorageManager.make(signer, server, () => false);
    sm2 = DroppingStorageManager.make(
      signer,
      server,
      () => dropActive,
      (n) => removed += n,
    );
  });
  afterEach(async () => {
    await sm1?.close();
    await sm2?.close();
    await server?.close();
  });

  async function runResumeWithMissingContainer<T>(
    program: RuntimeProgram,
    items: unknown,
    resultKey: string,
    resultField: string,
    read: (rc: Cell<any>) => T,
    expected: T,
  ): Promise<void> {
    // CREATE (runtime A): build and persist the durable aggregate, then resolve
    // the result container's own document id so the resume can withhold it.
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm1,
    });
    const compiled1 = await rt1.patternManager.compilePattern(program, {
      space,
    });
    const tx0 = rt1.edit();
    const rc1 = rt1.getCell(space, resultKey, compiled1.resultSchema, tx0);
    const h1 = rt1.run(tx0, compiled1, { items }, rc1);
    await tx0.commit();
    for (let k = 0; k < 10; k++) {
      await h1.pull();
      await rt1.idle();
    }
    await rt1.patternManager.flushCompileCacheWrites();
    await sm1.synced();
    expect(read(rc1)).toEqual(expected);

    // The result field's cell write-redirects to the builtin's container; the
    // resolved cell is the container document to withhold on resume.
    const resolveTx = rt1.edit();
    const container = rc1.key(resultField).withTx(resolveTx).resolveAsCell();
    droppedDocIds.add(String(container.getAsNormalizedFullLink().id));
    resolveTx.abort("resolve container id");
    expect(droppedDocIds.size).toBe(1);
    rt1.scheduler.dispose();

    // RESUME (runtime B): the transport removes the container document from every
    // sync, so the coordinator reconcile reads it undefined and takes the
    // defer-then-seed recovery path.
    dropActive = true;
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm2,
    });
    try {
      await rt2.patternManager.compilePattern(program, { space });
      const tx = rt2.edit();
      const rc2 = rt2.getCell(space, resultKey, compiled1.resultSchema, tx);
      await tx.commit();

      const started = await rt2.start(rc2);
      expect(started).toBe(true);

      for (let k = 0; k < 25; k++) {
        await rc2.pull();
        await rt2.idle();
      }

      // The container document was actually withheld; otherwise the defer path
      // is not exercised and the assertion below would pass vacuously.
      expect(removed).toBeGreaterThan(0);
      // Converges to the durable aggregate despite the missing container.
      expect(read(rc2)).toEqual(expected);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  }

  it("recovers a filter result whose container is missing on resume", async () => {
    await runResumeWithMissingContainer(
      FILTER_PROGRAM,
      FILTER_ITEMS,
      "cd-filter",
      "kept",
      (rc) =>
        (rc.key("kept").getAsQueryResult() ?? []).map(
          (x: { label: string }) => x.label,
        ),
      ["a", "b", "d"],
    );
  });

  it("recovers a flatMap result whose container is missing on resume", async () => {
    await runResumeWithMissingContainer(
      FLATMAP_PROGRAM,
      FLATMAP_ITEMS,
      "cd-flatmap",
      "values",
      (rc) => rc.key("values").getAsQueryResult() ?? [],
      [1, 3, 4],
    );
  });

  it("recovers a map result whose container is missing on resume", async () => {
    await runResumeWithMissingContainer(
      MAP_PROGRAM,
      MAP_ITEMS,
      "cd-map",
      "doubled",
      (rc) => rc.key("doubled").getAsQueryResult() ?? [],
      [2, 4, 6],
    );
  });
});
