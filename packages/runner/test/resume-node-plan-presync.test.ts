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
// document is an `asCell` position of the module schema, one link past the
// document the argument links to directly, so only the handler's plan
// reaches it.
const HANDLE_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { handler, pattern, type Stream, type Writable } from 'commonfabric';",
      "type Counter = { n: number };",
      "type Holder = { counter: Writable<Counter> };",
      "const bump = handler<unknown, { counter: Writable<Counter> }>(",
      "  (_event, { counter }) => { counter.set({ n: counter.get().n + 1 }); },",
      ");",
      "export default pattern<{ holder: Holder }, {",
      "  bump: Stream<unknown>;",
      "}>(({ holder }) => {",
      "  return { bump: bump({ counter: holder.counter }) };",
      "});",
    ].join("\n"),
  }],
};

// A child pattern whose authored argument type declares `friend`, a link no
// child body reads; the child's lift reads `def.name` only. The parent
// passes `def` through and reads nothing itself.
const NESTED_UNREAD_LINK_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern } from 'commonfabric';",
      "type Friend = { name?: string };",
      "type Profile = { name?: string; friend?: Friend };",
      "export const badge = pattern<{ def: Profile }, { label: string }>(",
      "  ({ def }) => {",
      "    const label = computed(() => `n:${def.name ?? 'none'}`);",
      "    return { label };",
      "  },",
      ");",
      "export default pattern<{ def: Profile }, {",
      "  child: { label: string };",
      "}>(({ def }) => {",
      "  const child = badge({ def });",
      "  return { child };",
      "});",
    ].join("\n"),
  }],
};

// A grandchild two levels down reads through a link its own argument type
// declares; the level between holds the value as `unknown`, so nothing the
// child declares reaches the document behind that link.
const GRANDCHILD_READ_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern } from 'commonfabric';",
      "type Leaf = { name?: string };",
      "type Top = { next?: Leaf };",
      "export const leaf = pattern<{ def: Top }, { label: string }>(",
      "  ({ def }) => {",
      "    const label = computed(() => `n:${def.next?.name ?? 'none'}`);",
      "    return { label };",
      "  },",
      ");",
      "export const mid = pattern<{ def: unknown }, {",
      "  grandchild: { label: string };",
      "}>(({ def }) => {",
      "  const grandchild = leaf({ def: def as Top });",
      "  return { grandchild };",
      "});",
      "export default pattern<{ def: Top }, {",
      "  child: { grandchild: { label: string } };",
      "}>(({ def }) => {",
      "  const child = mid({ def });",
      "  return { child };",
      "});",
    ].join("\n"),
  }],
};

// A body reads two links deep and the second link crosses into another
// space: the home space's argument document links to a document of its own
// whose `next` links into a profile space. The server's query walk stops at
// the space boundary, so the pre-sync itself must reach the far document.
const spaceP = (await Identity.fromPassphrase("resume node plan space P"))
  .did();

function commitConflictCount(): number {
  const counts = getLoggerCountsBreakdown()["storage.v2"] ?? {};
  return (counts as Record<string, { total?: number }>)["commit-conflict"]
    ?.total ?? 0;
}

/** How many nodes the pre-sync skipped for bindings it could not plan. */
function presyncSkipCount(): number {
  const counts = getLoggerCountsBreakdown()["runner"] ?? {};
  return (counts as Record<string, { total?: number }>)["resume-pre-sync"]
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

  /** Whether replica B holds the document `cell` names, in `inSpace`. */
  function localOnB(cell: Cell<unknown>, inSpace = space): boolean {
    const link = cell.getAsNormalizedFullLink();
    const replica = managerB.open(inSpace) as unknown as {
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
    const skipsBefore = presyncSkipCount();
    const resumed = await createAndResume(
      UNREAD_LINK_PROGRAM,
      { def: profile },
      "unread link parent",
    );
    // Every node was planned: `profile` is local because the plan named it,
    // not only because the argument links to it directly.
    expect(presyncSkipCount()).toBe(skipsBefore);
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
    const holder = rt1.getCell<{ counter: unknown }>(
      space,
      "handle holder doc",
      undefined,
      tx,
    );
    holder.withTx(tx).set({ counter });
    expect((await tx.commit()).error).toBeUndefined();

    const resumed = await createAndResume(
      HANDLE_PROGRAM,
      { holder },
      "handle parent",
    );
    // The handle's document is local before any dispatch: the argument links
    // to the holder, and only the handler's plan reaches the counter.
    expect(localOnB(counter)).toBe(true);
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

  it("leaves a link a child's authored type declares but no child body reads cold", async () => {
    const tx1 = rt1.edit();
    const friend = rt1.getCell<{ name?: string }>(
      space,
      "nested unread friend",
      undefined,
      tx1,
    );
    friend.withTx(tx1).set({ name: "Grace" });
    const profile = rt1.getCell<{ name?: string; friend?: unknown }>(
      space,
      "nested unread profile",
      undefined,
      tx1,
    );
    profile.withTx(tx1).set({ name: "Ada", friend });
    rt1.prepareTxForCommit(tx1);
    expect((await tx1.commit()).error).toBeUndefined();

    const before = commitConflictCount();
    const skipsBefore = presyncSkipCount();
    const resumed = await createAndResume(
      NESTED_UNREAD_LINK_PROGRAM,
      { def: profile },
      "nested unread parent",
    );
    expect(presyncSkipCount()).toBe(skipsBefore);
    expect(localOnB(profile)).toBe(true);
    expect(localOnB(friend)).toBe(false);
    await rt2.idle();
    expect(resumed.key("child").key("label").get()).toBe("n:Ada");
    expect(commitConflictCount()).toBe(before);
  });

  it("names a document a grandchild reads through a link the level between holds opaquely", async () => {
    const tx1 = rt1.edit();
    const leafDoc = rt1.getCell<{ name?: string }>(
      space,
      "grandchild read leaf",
      undefined,
      tx1,
    );
    leafDoc.withTx(tx1).set({ name: "Ada" });
    const top = rt1.getCell<{ next?: unknown }>(
      space,
      "grandchild read top",
      undefined,
      tx1,
    );
    top.withTx(tx1).set({ next: leafDoc });
    rt1.prepareTxForCommit(tx1);
    expect((await tx1.commit()).error).toBeUndefined();

    const before = commitConflictCount();
    const resumed = await createAndResume(
      GRANDCHILD_READ_PROGRAM,
      { def: top },
      "grandchild read parent",
    );
    expect(localOnB(leafDoc)).toBe(true);
    await rt2.idle();
    expect(
      resumed.key("child").key("grandchild").key("label").get(),
    ).toBe("n:Ada");
    expect(commitConflictCount()).toBe(before);
  });

  it("names what a fresh run's lift reads through the caller's argument before its first run", async () => {
    const tx1 = rt1.edit();
    const leafDoc = rt1.getCell<{ name?: string }>(
      space,
      "fresh run leaf",
      undefined,
      tx1,
    );
    leafDoc.withTx(tx1).set({ name: "Ada" });
    const midDoc = rt1.getCell<{ next?: unknown }>(
      space,
      "fresh run mid",
      undefined,
      tx1,
    );
    midDoc.withTx(tx1).set({ next: leafDoc });
    const top = rt1.getCell<{ next?: unknown }>(
      space,
      "fresh run top",
      undefined,
      tx1,
    );
    top.withTx(tx1).set({ next: midDoc });
    rt1.prepareTxForCommit(tx1);
    expect((await tx1.commit()).error).toBeUndefined();
    await rt1.storageManager.synced();

    // Runtime 2 has never seen any of these documents: the run is fresh on a
    // cold replica, and its argument names `top` by link.
    const compiled = await rt2.patternManager.compilePattern(
      DEEP_READ_PROGRAM,
      { space },
    );
    await rt2.patternManager.flushCompileCacheWrites();
    await rt2.storageManager.synced();
    const before = commitConflictCount();
    const top2 = rt2.getCellFromLink<{ next?: unknown }>(
      top.getAsNormalizedFullLink(),
    );
    const resultCell2 = rt2.getCell<Record<string, unknown>>(
      space,
      "fresh run result",
      undefined,
    );
    // What the replica holds the moment the first pre-sync step resolves,
    // before setup and the first run: the seam wraps the runner's own step,
    // and a later step on the same piece is not the one under test.
    let leafLocalAfterPresync: boolean | undefined;
    rt2.runner.accessForTestingOnly.dependencySyncer = async (
      target,
      pattern,
      inputs,
      sync,
    ) => {
      const walked = await sync(target, pattern, inputs);
      leafLocalAfterPresync ??= localOnB(leafDoc);
      return walked;
    };
    let cell: Cell<Record<string, unknown>>;
    try {
      cell = await rt2.runSynced(
        resultCell2,
        compiled as never,
        { def: top2 },
      );
    } finally {
      rt2.runner.accessForTestingOnly.dependencySyncer = undefined;
    }
    expect(leafLocalAfterPresync).toBe(true);
    await rt2.idle();
    await rt2.storageManager.synced();
    await rt2.idle();
    await cell.pull();
    await rt2.idle();
    expect(cell.key("label").get()).toBe("n:Ada");
    expect(commitConflictCount()).toBe(before);
    // One run: the lift found the documents local. A lift that ran cold
    // runs again when the loads its reads kicked land.
    const computations = rt2.scheduler.getGraphSnapshot().nodes.filter(
      (node) => node.type === "computation" && node.stats !== undefined,
    );
    expect(computations.length).toBeGreaterThan(0);
    expect(computations.map((node) => node.stats?.runCount)).toEqual(
      computations.map(() => 1),
    );
  });

  it("names a document a body reads through a link into another space", async () => {
    // A transaction writes one space, so the far document commits first.
    const txP = rt1.edit();
    const leafDoc = rt1.getCell<{ name?: string }>(
      spaceP,
      "cross-space leaf",
      undefined,
      txP,
    );
    leafDoc.withTx(txP).set({ name: "Ada" });
    rt1.prepareTxForCommit(txP);
    expect((await txP.commit()).error).toBeUndefined();
    const tx1 = rt1.edit();
    const midDoc = rt1.getCell<{ next?: unknown }>(
      space,
      "cross-space mid",
      undefined,
      tx1,
    );
    midDoc.withTx(tx1).set({ next: leafDoc });
    const top = rt1.getCell<{ next?: unknown }>(
      space,
      "cross-space top",
      undefined,
      tx1,
    );
    top.withTx(tx1).set({ next: midDoc });
    rt1.prepareTxForCommit(tx1);
    expect((await tx1.commit()).error).toBeUndefined();

    let leafLocalAfterPresync: boolean | undefined;
    rt2.runner.accessForTestingOnly.dependencySyncer = async (
      target,
      pattern,
      inputs,
      sync,
    ) => {
      const walked = await sync(target, pattern, inputs);
      leafLocalAfterPresync ??= localOnB(leafDoc, spaceP);
      return walked;
    };
    const before = commitConflictCount();
    try {
      const resumed = await createAndResume(
        DEEP_READ_PROGRAM,
        { def: top },
        "cross-space parent",
      );
      expect(leafLocalAfterPresync).toBe(true);
      await rt2.idle();
      await rt2.storageManager.synced();
      const label = resumed.key("label");
      await label.pull();
      expect(label.get()).toBe("n:Ada");
    } finally {
      rt2.runner.accessForTestingOnly.dependencySyncer = undefined;
    }
    expect(commitConflictCount()).toBe(before);
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
