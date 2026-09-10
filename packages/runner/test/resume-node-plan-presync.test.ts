import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { getLoggerCountsBreakdown } from "@commonfabric/utils/logger";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { Cell } from "../src/cell.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("resume node plan presync");
const space = signer.did();

// The resume pre-sync names what each node's first run reads, under the
// schema the transformer narrowed that node to. Two managers with their own
// replicas loopback-connected to one server: the second resumes cold, so
// what its replica holds after the pre-sync is what the pre-sync named.

// The authored argument type declares `friend`, a link no body reads; the
// lift reads `def.name` only.
const UNREAD_LINK_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern } from 'commonfabric';",
      "type Friend = { name?: string };",
      "type Profile = { name?: string; friend?: Friend };",
      "export default pattern<{ def: Profile }, { label: string }>(",
      "  ({ def }) => {",
      "    const label = computed(() => `n:${def.name ?? 'none'}`);",
      "    return { label };",
      "  },",
      ");",
    ].join("\n"),
  }],
};

// The lift reads three documents deep: `def` links to a document whose
// `next` links to a document whose `next` links to the one holding `name`.
const DEEP_READ_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern } from 'commonfabric';",
      "type Leaf = { name?: string };",
      "type Mid = { next?: Leaf };",
      "type Top = { next?: Mid };",
      "export default pattern<{ def: Top }, { label: string }>(",
      "  ({ def }) => {",
      "    const label = computed(() => `n:${def.next?.next?.name ?? 'none'}`);",
      "    return { label };",
      "  },",
      ");",
    ].join("\n"),
  }],
};

// A handler holding a cell handle it reads synchronously: the handle's
// document is an `asCell` position of the module schema.
const HANDLE_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { handler, pattern, type Stream, type Writable } from 'commonfabric';",
      "type Counter = { n: number };",
      "const bump = handler<unknown, { counter: Writable<Counter> }>(",
      "  (_event, { counter }) => { counter.set({ n: counter.get().n + 1 }); },",
      ");",
      "export default pattern<{ counter: Writable<Counter> }, {",
      "  bump: Stream<unknown>;",
      "}>(({ counter }) => {",
      "  return { bump: bump({ counter }) };",
      "});",
    ].join("\n"),
  }],
};

function commitConflictCount(): number {
  const counts = getLoggerCountsBreakdown()["storage.v2"] ?? {};
  return (counts as Record<string, { total?: number }>)["commit-conflict"]
    ?.total ?? 0;
}

describe("resume node plan pre-sync", () => {
  let server: MemoryV2Server.Server;
  let managerA: EmulatedStorageManager;
  let managerB: EmulatedStorageManager;
  let rt1: Runtime;
  let rt2: Runtime;

  beforeEach(() => {
    server = newSharedServer();
    managerA = EmulatedStorageManager.connectTo(server, { as: signer });
    managerB = EmulatedStorageManager.connectTo(server, { as: signer });
    rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: managerA,
    });
    rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: managerB,
    });
  });

  afterEach(async () => {
    await rt1.dispose();
    await rt2.dispose();
    await managerA.close();
    await managerB.close();
    await server.close();
  });

  /** Whether replica B holds the document `cell` names. */
  function localOnB(cell: Cell<unknown>): boolean {
    const link = cell.getAsNormalizedFullLink();
    const replica = managerB.open(space) as unknown as {
      get?: (uri: string, scope?: unknown) => unknown;
    };
    return replica.get?.(link.id, link.scope) !== undefined;
  }

  /** Creates and settles a piece on runtime 1, then resumes it cold on 2. */
  async function createAndResume(
    program: RuntimeProgram,
    argument: Record<string, unknown>,
    resultCause: string,
  ): Promise<Cell<Record<string, unknown>>> {
    const tx1 = rt1.edit();
    const compiled = await rt1.patternManager.compilePattern(program, {
      space,
      tx: tx1,
    });
    const resultCell1 = rt1.getCell<Record<string, unknown>>(
      space,
      resultCause,
      undefined,
      tx1,
    );
    // deno-lint-ignore no-explicit-any
    const r1 = rt1.run(tx1, compiled as any, argument, resultCell1);
    rt1.prepareTxForCommit(tx1);
    expect((await tx1.commit()).error).toBeUndefined();
    await r1.pull();
    await rt1.idle();
    await rt1.patternManager.flushCompileCacheWrites();
    await rt1.storageManager.synced();
    await rt1.idle();
    await rt1.storageManager.synced();

    const parentCell2 = rt2.getCellFromLink<Record<string, unknown>>(
      r1.getAsNormalizedFullLink(),
    );
    await parentCell2.sync();
    expect(await rt2.start(parentCell2)).toBeTruthy();
    return parentCell2;
  }

  it("leaves a link the authored type declares but no body reads cold", async () => {
    const tx = rt1.edit();
    const friend = rt1.getCell<{ name?: string }>(
      space,
      "unread friend doc",
      undefined,
      tx,
    );
    friend.withTx(tx).set({ name: "Grace" });
    const profile = rt1.getCell<{ name?: string; friend?: unknown }>(
      space,
      "read profile doc",
      undefined,
      tx,
    );
    profile.withTx(tx).set({ name: "Ada", friend });
    expect((await tx.commit()).error).toBeUndefined();

    const conflictsBefore = commitConflictCount();
    const resumed = await createAndResume(
      UNREAD_LINK_PROGRAM,
      { def: profile },
      "unread link parent",
    );
    await rt2.idle();
    await rt2.storageManager.synced();
    const label = resumed.key("label");
    await label.pull();
    expect(label.get()).toBe("n:Ada");

    expect(localOnB(profile)).toBe(true);
    expect(localOnB(friend)).toBe(false);
    expect(commitConflictCount() - conflictsBefore).toBe(0);
  });

  it("finds a handler's cell handle local at dispatch", async () => {
    const tx = rt1.edit();
    const counter = rt1.getCell<{ n: number }>(
      space,
      "handle counter doc",
      undefined,
      tx,
    );
    counter.withTx(tx).set({ n: 1 });
    expect((await tx.commit()).error).toBeUndefined();

    const resumed = await createAndResume(
      HANDLE_PROGRAM,
      { counter },
      "handle parent",
    );
    await rt2.idle();
    // The handler reads the handle synchronously; a cold handle document
    // reads as absent and the body throws instead of writing.
    resumed.key("bump").send({});
    await rt2.idle();
    await rt2.storageManager.synced();
    await rt1.storageManager.synced();
    const counter1 = rt1.getCellFromLink<{ n: number }>(
      counter.getAsNormalizedFullLink(),
    );
    await counter1.pull();
    expect(counter1.get().n).toBe(2);
  });

  it("names a document a body reads three links deep", async () => {
    const tx = rt1.edit();
    const leaf = rt1.getCell<{ name?: string }>(
      space,
      "deep leaf",
      undefined,
      tx,
    );
    leaf.withTx(tx).set({ name: "Ada" });
    const mid = rt1.getCell<{ next?: unknown }>(
      space,
      "deep mid",
      undefined,
      tx,
    );
    mid.withTx(tx).set({ next: leaf });
    const top = rt1.getCell<{ next?: unknown }>(
      space,
      "deep top",
      undefined,
      tx,
    );
    top.withTx(tx).set({ next: mid });
    expect((await tx.commit()).error).toBeUndefined();

    const conflictsBefore = commitConflictCount();
    const resumed = await createAndResume(
      DEEP_READ_PROGRAM,
      { def: top },
      "deep read parent",
    );
    // What the pre-sync named is what the replica holds before any run
    // reads: the leaf arrived with the start, not with a later read.
    expect(localOnB(leaf)).toBe(true);
    await rt2.idle();
    await rt2.storageManager.synced();
    const label = resumed.key("label");
    await label.pull();
    expect(label.get()).toBe("n:Ada");
    expect(commitConflictCount() - conflictsBefore).toBe(0);
  });
});
