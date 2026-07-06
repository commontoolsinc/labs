// Probe + regression for the residual profile-append-during-rehydration loss
// (docs/development/mergeable-collection-writes.md "Residual" section), distilled
// to the essential runtime mechanism and made deterministic:
//
//   A single event handler that, in ONE multi-space transaction, mergeable-appends
//   to a home-space list AND creates a cross-space `inSpace` child — the shape of
//   `submitProfileCreation` pushing a `ProfileHome.inSpace()` onto the home
//   `profiles` list.
//
// During a reload storm the home-space commit hits transient rejections. This
// test injects that storm deterministically: the home replica's commit is failed
// a handful of times with a NON-conflict transient error (a same-replica race,
// the kind the rehydration churn produces), then allowed through. The
// cross-space child lands on its first attempt (multi-space commits have no
// rollback), so the profile's ProfileHome exists — but the mergeable append is
// dropped when the event handler exhausts its bounded-retry budget and gives up,
// leaving the profile absent from the list. That is the residual loss.
//
// The append is add-wins and commutes; it must not be dropped just because the
// surrounding multi-space commit exhausted its retry budget on unrelated churn.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { Options } from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { TEST_MEMORY_SERVER_AUTH } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("mergeable-append-multispace");
const space = signer.did();

class SharedServerStorageManager extends EmulatedStorageManager {
  static connectTo(
    server: MemoryV2Server.Server,
    options: Omit<Options, "memoryHost" | "spaceHostMap">,
  ): SharedServerStorageManager {
    const manager = new SharedServerStorageManager(
      { ...options, memoryHost: new URL("memory://") },
      () => server,
    );
    manager.sharedServer = server;
    return manager;
  }
  private sharedServer!: MemoryV2Server.Server;
  protected override server(): MemoryV2Server.Server {
    return this.sharedServer;
  }
}

const newSharedServer = () =>
  new MemoryV2Server.Server({
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
  });

// A child pattern instantiated in its own anonymous inSpace space, plus a host
// that holds the home `items` list and an `addItem` handler that pushes a
// cross-space child onto `items` (a multi-space commit).
const CHILD_SRC = [
  "import { pattern, computed } from 'commonfabric';",
  "export default pattern<{ seed: string }, { label: unknown }>(({ seed }) => {",
  "  const label = computed(() => `child-${seed}`);",
  "  return { label };",
  "});",
].join("\n");

const HOST_SRC = [
  "import { pattern, handler, Writable } from 'commonfabric';",
  "import Child from './child.tsx';",
  "",
  "const addItem = handler<{ seed: string }, {",
  "  items: Writable<unknown[]>;",
  "}>((event, { items }) => {",
  "  items.push(Child.inSpace()({ seed: event.seed }));",
  "});",
  "",
  "export default pattern(() => {",
  "  const items = new Writable<unknown[]>([]).for('items');",
  "  return { items, addItem: addItem({ items }) };",
  "});",
].join("\n");

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    { name: "/main.tsx", contents: HOST_SRC },
    { name: "/child.tsx", contents: CHILD_SRC },
  ],
};

const RESULT_CAUSE = "mergeable-append-multispace host";

const itemLinkListSchema = {
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
  // deno-lint-ignore no-explicit-any
} as any;

async function readDurableItemCount(
  server: MemoryV2Server.Server,
): Promise<number> {
  const storage = SharedServerStorageManager.connectTo(server, { as: signer });
  const rt = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
  });
  try {
    const tx = rt.edit();
    const parent = await rt.patternManager.compilePattern(PROGRAM, {
      space,
      tx,
    });
    const resultCell = rt.getCell<Record<string, unknown>>(
      space,
      RESULT_CAUSE,
      undefined,
      tx,
    );
    // deno-lint-ignore no-explicit-any
    const handle = rt.run(tx, parent as any, {}, resultCell);
    rt.prepareTxForCommit(tx);
    await tx.commit();
    for (let i = 0; i < 8; i++) {
      await handle.pull();
      await rt.idle();
      await storage.synced();
    }
    const items = handle.key("items").asSchema(itemLinkListSchema)
      // deno-lint-ignore no-explicit-any
      .get() as any[];
    return Array.isArray(items) ? items.length : 0;
  } finally {
    await rt.dispose();
    await storage.close();
  }
}

describe("mergeable append in a multi-space commit survives a transient storm", () => {
  let server: MemoryV2Server.Server;
  let manager: SharedServerStorageManager;
  let rt: Runtime;

  beforeEach(() => {
    server = newSharedServer();
    manager = SharedServerStorageManager.connectTo(server, { as: signer });
    rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
    });
  });
  afterEach(async () => {
    await rt.dispose();
    await manager.close();
    await server.close();
  });

  it("the append survives when the home commit hits transient non-conflict rejections", async () => {
    const tx = rt.edit();
    const parent = await rt.patternManager.compilePattern(PROGRAM, {
      space,
      tx,
    });
    const resultCell = rt.getCell<Record<string, unknown>>(
      space,
      RESULT_CAUSE,
      undefined,
      tx,
    );
    // deno-lint-ignore no-explicit-any
    const handle = rt.run(tx, parent as any, {}, resultCell);
    rt.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    await handle.pull();
    await rt.idle();
    await manager.synced();

    // Wrap the HOME replica's commitNative to inject a transient, non-conflict
    // rejection (a same-replica inconsistency, the kind the rehydration storm
    // produces) for the first several commit attempts, then let it through. The
    // count (8) is above the event handler's fixed retry budget
    // (DEFAULT_RETRIES_FOR_EVENTS = 5), so the pre-fix handler exhausts its
    // budget and gives up before the storm clears. The cross-space child lives
    // in its own replica and is unaffected: it commits durably on the first
    // attempt (the multi-space split has no rollback), so pre-fix the child
    // exists but the home append is dropped.
    const replica = manager.open(space).replica as unknown as {
      commitNative: (...args: unknown[]) => Promise<unknown>;
    };
    const realCommitNative = replica.commitNative.bind(replica);
    let injectedRemaining = 8;
    replica.commitNative = (...args: unknown[]) => {
      if (injectedRemaining > 0) {
        injectedRemaining--;
        return Promise.resolve({
          error: {
            name: "StorageTransactionInconsistent",
            message: "injected transient storm rejection",
          },
        });
      }
      return realCommitNative(...args);
    };

    // Fire the multi-space create. Its home append hits the injected storm.
    const addTx = rt.edit();
    handle.withTx(addTx).key("addItem").send({ seed: "X" });
    await addTx.commit();
    for (let i = 0; i < 30; i++) {
      await rt.idle();
      await manager.synced();
    }

    // The append must survive: after the transient storm clears, the item is in
    // the durable list. Pre-fix the event handler exhausts its bounded-retry
    // budget on the injected non-conflict errors and gives up, dropping the
    // mergeable append even though it commutes and could never truly conflict.
    const count = await readDurableItemCount(server);
    expect(count).toBe(1);

    // The handler rode out the whole storm (8 rejections, above the fixed
    // budget) rather than giving up partway through.
    expect(injectedRemaining).toBe(0);
  });

  it("a non-stale-basis rejection on a mergeable commit still fails fast (not windowed)", async () => {
    const tx = rt.edit();
    const parent = await rt.patternManager.compilePattern(PROGRAM, {
      space,
      tx,
    });
    const resultCell = rt.getCell<Record<string, unknown>>(
      space,
      RESULT_CAUSE,
      undefined,
      tx,
    );
    // deno-lint-ignore no-explicit-any
    const handle = rt.run(tx, parent as any, {}, resultCell);
    rt.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    await handle.pull();
    await rt.idle();
    await manager.synced();

    // Inject an AuthorizationError — a non-stale-basis rejection that re-running
    // cannot resolve. The mergeable op present in the commit must NOT widen this
    // into the retry window; it keeps the fixed budget and gives up. The count
    // (8) is above the budget, so if it were wrongly windowed the handler would
    // ride past the injections and land the append.
    const replica = manager.open(space).replica as unknown as {
      commitNative: (...args: unknown[]) => Promise<unknown>;
    };
    const realCommitNative = replica.commitNative.bind(replica);
    let injectedRemaining = 8;
    replica.commitNative = (...args: unknown[]) => {
      if (injectedRemaining > 0) {
        injectedRemaining--;
        return Promise.resolve({
          error: {
            name: "AuthorizationError",
            message: "injected non-stale-basis rejection",
          },
        });
      }
      return realCommitNative(...args);
    };

    let sawWindowedBackoff = false;
    // deno-lint-ignore no-explicit-any
    rt.telemetry.addEventListener("telemetry", (ev: any) => {
      const m = ev.marker;
      if (m?.type === "scheduler.event.commit" && m.backoffMs !== undefined) {
        sawWindowedBackoff = true;
      }
    });

    const addTx = rt.edit();
    handle.withTx(addTx).key("addItem").send({ seed: "Y" });
    await addTx.commit();
    for (let i = 0; i < 30; i++) {
      await rt.idle();
      await manager.synced();
    }

    // The handler gave up on the fixed budget before the injections cleared, so
    // the append did not land and the window was never entered.
    expect(await readDurableItemCount(server)).toBe(0);
    expect(sawWindowedBackoff).toBe(false);
    expect(injectedRemaining).toBeGreaterThan(0);
  });
});
