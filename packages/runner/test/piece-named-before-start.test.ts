import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  it,
} from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import type { Pattern } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { getDerivedInternalCellLink, parseLink } from "../src/link-utils.ts";
import { entityKey } from "../src/scheduler/keys.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { CommitError } from "../src/storage/interface.ts";
import { type ErrorWithContext, Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("piece named before start");
const space = signer.did();

// A host whose list maps each item onto a card carrying a handler. The
// card's `{ "$stream": true }` marker is an internal cell of the card, which
// a replica reading the card through the list does not receive: the card's
// family belongs to whoever names it.
const CARD_SRC = [
  "import { pattern, computed, handler, type Stream, Writable } from 'commonfabric';",
  "const bump = handler<unknown, { count: Writable<number> }>((_, { count }) => {",
  "  count.set(count.get() + 1);",
  "});",
  "export default pattern<{ item: { seed: string } }, { label: string; count: number; bump: Stream<unknown>; item: { seed: string } }>(({ item }) => {",
  "  const label = computed(() => `card-${item.seed}`);",
  "  const count = new Writable(0).for('count');",
  "  return { label, count, bump: bump({ count }), item };",
  "});",
].join("\n");
const HOST_SRC = [
  "import { pattern, handler, Writable } from 'commonfabric';",
  "import Card from './card.tsx';",
  "",
  "const addItem = handler<{ seed: string }, {",
  "  items: Writable<{ seed: string }[]>;",
  "}>((event, { items }) => {",
  "  items.push({ seed: event.seed });",
  "});",
  "",
  "export default pattern(() => {",
  "  const items = new Writable<{ seed: string }[]>([]).for('items');",
  "  const cards = items.map((item) => Card({ item }));",
  "  return { items, cards, addItem: addItem({ items }) };",
  "});",
].join("\n");
// The card upgraded: a second handler, whose marker is another internal cell.
const CARD_V2_SRC = [
  "import { pattern, computed, handler, type Stream, Writable } from 'commonfabric';",
  "const bump = handler<unknown, { count: Writable<number> }>((_, { count }) => {",
  "  count.set(count.get() + 1);",
  "});",
  "const poke = handler<unknown, { count: Writable<number> }>((_, { count }) => {",
  "  count.set(count.get() + 10);",
  "});",
  "export default pattern<{ item: { seed: string } }, { label: string; count: number; bump: Stream<unknown>; poke: Stream<unknown>; item: { seed: string } }>(({ item }) => {",
  "  const label = computed(() => `card-${item.seed}`);",
  "  const count = new Writable(0).for('count');",
  "  return { label, count, bump: bump({ count }), poke: poke({ count }), item };",
  "});",
].join("\n");
const FILES = [
  { name: "/main.tsx", contents: HOST_SRC },
  { name: "/card.tsx", contents: CARD_SRC },
  { name: "/card-v2.tsx", contents: CARD_V2_SRC },
];
const HOST_PROGRAM: RuntimeProgram = { main: "/main.tsx", files: FILES };
const CARD_PROGRAM: RuntimeProgram = { main: "/card.tsx", files: FILES };
const CARD_V2_PROGRAM: RuntimeProgram = { main: "/card-v2.tsx", files: FILES };
const RESULT_CAUSE = "piece named before start host";
const CARDS_SCHEMA = {
  type: "array",
  items: { type: "object", properties: { label: { type: "string" } } },
} as const;
// Reaches each card's argument document through the card's `item`, as a
// crossing: the document, and none of the card's family.
const CARDS_ITEM_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      label: { type: "string" },
      item: { type: "object", properties: { seed: { type: "string" } } },
    },
  },
} as const;
// One card per case, each cold on the replica that runs it.
const CARD_COUNT = 8;

type EventCommitMarker = {
  type: "scheduler.event.commit";
  error?: string;
};

type DeferredStartMarker = {
  type: string;
  key?: string;
  outcome?: string;
};

function waitForEventCommit(runtime: Runtime): Promise<EventCommitMarker> {
  return new Promise((resolve) => {
    const listener = (event: Event) => {
      const marker = (event as CustomEvent<{ marker: EventCommitMarker }>)
        .detail.marker;
      if (marker.type !== "scheduler.event.commit" || marker.error) return;
      runtime.telemetry.removeEventListener("telemetry", listener);
      resolve(marker);
    };
    runtime.telemetry.addEventListener("telemetry", listener);
  });
}

/** Resolves with the next deferred-start marker of `type` for `key`. */
function waitForDeferredStart(
  runtime: Runtime,
  type: "runner.deferred-start.pending" | "runner.deferred-start.settled",
  key: string,
): Promise<DeferredStartMarker> {
  return new Promise((resolve) => {
    const listener = (event: Event) => {
      const marker = (event as CustomEvent<{ marker: DeferredStartMarker }>)
        .detail.marker;
      if (marker.type !== type || marker.key !== key) return;
      runtime.telemetry.removeEventListener("telemetry", listener);
      resolve(marker);
    };
    runtime.telemetry.addEventListener("telemetry", listener);
  });
}

describe("piece-named-before-start", () => {
  let server: MemoryV2Server.Server;
  let managers: EmulatedStorageManager[];
  let runtimes: Runtime[];
  let errors: Map<Runtime, ErrorWithContext[]>;

  function replica(): Runtime {
    const manager = EmulatedStorageManager.connectTo(server, { as: signer });
    const seen: ErrorWithContext[] = [];
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      errorHandlers: [(error) => {
        seen.push(error);
      }],
    });
    managers.push(manager);
    runtimes.push(runtime);
    errors.set(runtime, seen);
    return runtime;
  }

  async function quiesce(runtime: Runtime) {
    for (let i = 0; i < 4; i++) {
      await runtime.idle();
      await runtime.storageManager.synced();
    }
  }

  // BUILD, once: replica A sets up the host and every card its map runs,
  // then leaves. From then on only a replica that runs a card itself can
  // handle that card's events.
  beforeAll(async () => {
    server = newSharedServer();
    managers = [];
    runtimes = [];
    errors = new Map();
    const a = replica();
    const txA = a.edit();
    const compiledA = await a.patternManager.compilePattern(HOST_PROGRAM, {
      space,
      tx: txA,
    });
    const rcA = a.getCell<Record<string, unknown>>(
      space,
      RESULT_CAUSE,
      undefined,
      txA,
    );
    // deno-lint-ignore no-explicit-any
    const handleA = a.run(txA, compiledA as any, {}, rcA);
    a.prepareTxForCommit(txA);
    expect((await txA.commit()).error).toBeUndefined();
    await handleA.pull();
    await quiesce(a);
    for (let seed = 1; seed <= CARD_COUNT; seed++) {
      const addA = a.edit();
      const committedA = waitForEventCommit(a);
      handleA.withTx(addA).key("addItem").send({ seed: String(seed) });
      await addA.commit();
      await committedA;
    }
    for (let i = 0; i < 8; i++) {
      await handleA.pull();
      await quiesce(a);
    }
    await a.patternManager.flushCompileCacheWrites();
    await a.storageManager.synced();
    await a.dispose({ closeStorage: false });
    runtimes.splice(runtimes.indexOf(a), 1);
  });

  afterAll(async () => {
    for (const manager of managers) await manager.close();
    await server.close();
  });

  // Each case gets a replica B of its own, which reads the cards through the
  // list — the walk that reaches each card as a crossing, delivering its
  // document and none of its family — and never starts the host, so nothing
  // names a card on its behalf.
  let b: Runtime;
  let cardPattern: Pattern;
  let replicaB: {
    getDocument(id: string): Record<string, unknown> | undefined;
  };
  let rcB: Cell<Record<string, unknown>>;

  beforeEach(async () => {
    b = replica();
    cardPattern = await b.patternManager.compilePattern(CARD_PROGRAM, {
      space,
    }) as Pattern;
    rcB = b.getCell<Record<string, unknown>>(space, RESULT_CAUSE, undefined);
    await rcB.key("cards").asSchema(CARDS_SCHEMA).sync();
    await quiesce(b);
    replicaB = (b.storageManager.open(space) as unknown as {
      replica: typeof replicaB;
    }).replica;
  });

  afterEach(async () => {
    b.runner.accessForTestingOnly.dependencySyncer = undefined;
    b.runner.accessForTestingOnly.deferredStartCommitter = undefined;
    await b.dispose({ closeStorage: false });
    runtimes.splice(runtimes.indexOf(b), 1);
  });

  const linkTargetId = (value: unknown): string | undefined =>
    parseLink(value, rcB)?.id;

  /**
   * The card at `index`, located through the replica's documents alone so
   * that finding it names nothing: the container's slot holds the card's
   * exposed view, whose redirect chain ends at the cell the map ran the card
   * over — the cell the card's derived cells are minted from — and the item
   * document the map handed it is the host's items slot.
   */
  function locateCard(index: number): {
    cardB: Cell<Record<string, unknown>>;
    itemB: Cell<{ seed: string }>;
    argumentId: string;
    key: ReturnType<typeof entityKey>;
  } {
    const hostValue = replicaB.getDocument(rcB.getAsNormalizedFullLink().id)
      ?.value as { cards: unknown; items: unknown };
    let containerValue: unknown = hostValue.cards;
    for (let i = 0; i < 6 && !Array.isArray(containerValue); i++) {
      containerValue = replicaB.getDocument(linkTargetId(containerValue)!)
        ?.value;
    }
    const slotLinks = containerValue as unknown[];
    expect(Array.isArray(slotLinks) && slotLinks.length).toBe(CARD_COUNT);
    const chainIds: string[] = [linkTargetId(slotLinks[index])!];
    for (let i = 0; i < 6; i++) {
      const next = linkTargetId(
        replicaB.getDocument(chainIds[chainIds.length - 1])?.value,
      );
      if (next === undefined) break;
      chainIds.push(next);
    }
    const countDescriptor = cardPattern.derivedInternalCells!
      .find((d) => d.partialCause === "count")!;
    const resultValue = replicaB.getDocument(chainIds[chainIds.length - 1])
      ?.value as { count: unknown };
    const countId = linkTargetId(resultValue.count);
    const cardId = chainIds.find((id) =>
      getDerivedInternalCellLink(
        b.getCellFromEntityId(space, id),
        countDescriptor,
      ).id === countId
    )!;
    const cardB = b.getCellFromEntityId<Record<string, unknown>>(space, cardId);
    const itemLinks =
      (Array.isArray(hostValue.items)
        ? hostValue.items
        : replicaB.getDocument(linkTargetId(hostValue.items)!)
          ?.value) as unknown[];
    const itemB = b.getCellFromEntityId<{ seed: string }>(
      space,
      linkTargetId(itemLinks[index])!,
    );
    const argumentId = linkTargetId(replicaB.getDocument(cardId)?.argument)!;
    return {
      cardB,
      itemB,
      argumentId,
      key: entityKey(cardB.getAsNormalizedFullLink(), b.scopeKeyIdentity),
    };
  }

  /** Runs `cardB` the way a map's reconcile runs its child: in a transaction of B's own. */
  async function runCard(
    cardB: Cell<Record<string, unknown>>,
    itemB: Cell<{ seed: string }>,
    times = 1,
  ): Promise<void> {
    const runTx = b.edit();
    for (let i = 0; i < times; i++) {
      b.runner.run(runTx, cardPattern, { item: itemB }, cardB);
    }
    b.prepareTxForCommit(runTx);
    expect((await runTx.commit()).error).toBeUndefined();
  }

  /** Names `id` and, to `depth`, every document its value links to. */
  async function nameLinkChain(id: string, depth: number): Promise<void> {
    await b.getCellFromEntityId(space, id).sync();
    await quiesce(b);
    if (depth === 0) return;
    const value = replicaB.getDocument(id)?.value;
    const targets: string[] = [];
    const collect = (candidate: unknown) => {
      const target = linkTargetId(candidate);
      if (target !== undefined) {
        targets.push(target);
      } else if (candidate !== null && typeof candidate === "object") {
        for (const field of Object.values(candidate as object)) collect(field);
      }
    };
    collect(value);
    for (const target of targets) await nameLinkChain(target, depth - 1);
  }

  /** Sends the card's `stream` event from B and reads the count B's handler moved. */
  async function send(
    cardB: Cell<Record<string, unknown>>,
    stream: "bump" | "poke",
  ): Promise<unknown> {
    const sendTx = b.edit();
    const committedB = waitForEventCommit(b);
    cardB.withTx(sendTx).key(stream).send({});
    await sendTx.commit();
    await committedB;
    await quiesce(b);
    return cardB.key("count").get();
  }

  const bump = (cardB: Cell<Record<string, unknown>>) => send(cardB, "bump");

  it("names a piece set up elsewhere before running it, so its handler marker is present", async () => {
    const { cardB, itemB, argumentId, key } = locateCard(0);
    // Nothing named the card: its argument document is not local.
    expect(replicaB.getDocument(argumentId)).toBeUndefined();

    // The card's family is not local, so the run names the card and runs it
    // once the name-sync lands, rather than reading the absent family into
    // this transaction's basis.
    const pending = waitForDeferredStart(
      b,
      "runner.deferred-start.pending",
      key,
    );
    const settled = waitForDeferredStart(
      b,
      "runner.deferred-start.settled",
      key,
    );
    await runCard(cardB, itemB);
    await pending;
    expect((await settled).outcome).toBe("installed");
    await quiesce(b);
    expect(errors.get(b)!.map((error) => error.message)).toEqual([]);

    // The handler runs on B: the count it owns moves.
    expect(await bump(cardB)).toBe(1);
    expect(errors.get(b)!.map((error) => error.message)).toEqual([]);
  });

  it("holds the run while an owned cell is absent even when the argument document is local", async () => {
    const { cardB, itemB, argumentId, key } = locateCard(1);
    await rcB.key("cards").asSchema(CARDS_ITEM_SCHEMA).sync();
    await quiesce(b);
    expect(replicaB.getDocument(argumentId)).toBeDefined();
    const countId = getDerivedInternalCellLink(
      cardB,
      cardPattern.derivedInternalCells!.find((d) =>
        d.partialCause === "count"
      )!,
    ).id;
    expect(replicaB.getDocument(countId)).toBeUndefined();

    const settled = waitForDeferredStart(
      b,
      "runner.deferred-start.settled",
      key,
    );
    await runCard(cardB, itemB);
    expect((await settled).outcome).toBe("installed");
    await quiesce(b);
    expect(await bump(cardB)).toBe(1);
    expect(errors.get(b)!.map((error) => error.message)).toEqual([]);
  });

  it("runs a piece whose family is local without holding it", async () => {
    const { cardB, itemB, argumentId, key } = locateCard(2);
    // Naming the argument document delivers the card's family with it: the
    // document's `result` names the card, whose manifest names its cells.
    // What the argument links to — the map child's own argument, and the
    // item behind it — is named hop by hop, as the run would read it.
    await nameLinkChain(argumentId, 4);
    await itemB.sync();
    await quiesce(b);
    let held = false;
    waitForDeferredStart(b, "runner.deferred-start.pending", key).then(() => {
      held = true;
    });
    await runCard(cardB, itemB);
    await quiesce(b);
    expect(held).toBe(false);
    expect(await bump(cardB)).toBe(1);
    expect(errors.get(b)!.map((error) => error.message)).toEqual([]);
  });

  it("holds a second run of the same piece while its name-sync is in flight", async () => {
    const { cardB, itemB, key } = locateCard(3);
    let syncs = 0;
    b.runner.accessForTestingOnly.dependencySyncer = (
      resultCell,
      pattern,
      inputs,
      sync,
    ) => {
      syncs++;
      return sync(resultCell, pattern, inputs);
    };
    const settled = waitForDeferredStart(
      b,
      "runner.deferred-start.settled",
      key,
    );
    await runCard(cardB, itemB, 2);
    expect((await settled).outcome).toBe("installed");
    await quiesce(b);
    // One name-sync, one registration, one handler: the event is handled
    // once.
    expect(syncs).toBe(1);
    expect(await bump(cardB)).toBe(1);
    expect(errors.get(b)!.map((error) => error.message)).toEqual([]);
  });

  it("cancels the run when the piece is released before its name-sync lands", async () => {
    const { cardB, itemB, key } = locateCard(4);
    // The name-sync is held open until the release has landed, so the order
    // is the test's, not the wire's.
    const landing = Promise.withResolvers<void>();
    b.runner.accessForTestingOnly.dependencySyncer = async (
      resultCell,
      pattern,
      inputs,
      sync,
    ) => {
      await landing.promise;
      return await sync(resultCell, pattern, inputs);
    };
    const settled = waitForDeferredStart(
      b,
      "runner.deferred-start.settled",
      key,
    );
    await runCard(cardB, itemB);
    b.runner.releaseChild(cardB, undefined);
    expect((await settled).outcome).toBe("cancelled");
    landing.resolve();
    await quiesce(b);
    expect(b.runner.cancels.has(key)).toBe(false);
    expect(errors.get(b)!.map((error) => error.message)).toEqual([]);
  });

  it("runs the piece once a rejected name-sync has settled", async () => {
    const { cardB, itemB, key } = locateCard(5);
    // The sync does its work and then rejects: what a failed follow-up load
    // after the family landed looks like.
    b.runner.accessForTestingOnly.dependencySyncer = async (
      resultCell,
      pattern,
      inputs,
      sync,
    ) => {
      await sync(resultCell, pattern, inputs);
      throw new Error("synthetic name-sync rejection");
    };
    const settled = waitForDeferredStart(
      b,
      "runner.deferred-start.settled",
      key,
    );
    await runCard(cardB, itemB);
    expect((await settled).outcome).toBe("installed");
    await quiesce(b);
    expect(await bump(cardB)).toBe(1);
    expect(errors.get(b)!.map((error) => error.message)).toEqual([]);
  });

  it("releases the start when the named run's commit is refused", async () => {
    const { cardB, itemB, key } = locateCard(6);
    const refusal = new Error("synthetic refusal");
    b.runner.accessForTestingOnly.deferredStartCommitter = (
      tx,
      _resultCell,
      _commit,
    ) => {
      // A refused commit applies nothing, so discard this attempt's writes
      // the way the rollback behind a server refusal does.
      tx.abort(refusal.message);
      return Promise.resolve({ error: refusal as CommitError });
    };
    // The start installs before its commit is refused, and the refusal
    // releases what it installed.
    const settled = waitForDeferredStart(
      b,
      "runner.deferred-start.settled",
      key,
    );
    await runCard(cardB, itemB);
    expect((await settled).outcome).toBe("installed");
    await quiesce(b);
    expect(b.runner.cancels.has(key)).toBe(false);
  });

  it("runs a piece under a pattern it was upgraded to elsewhere after an earlier landing", async () => {
    const { cardB, itemB, key } = locateCard(7);
    const landedV1 = waitForDeferredStart(
      b,
      "runner.deferred-start.settled",
      key,
    );
    await runCard(cardB, itemB);
    expect((await landedV1).outcome).toBe("installed");
    await quiesce(b);
    expect(await bump(cardB)).toBe(1);

    // Replica C upgrades the card: its setup under the new pattern writes the
    // second handler's marker, which B's crossing never delivers.
    const c = replica();
    const cardV2 = await c.patternManager.compilePattern(CARD_V2_PROGRAM, {
      space,
    }) as Pattern;
    const cardC = c.getCellFromEntityId<Record<string, unknown>>(
      space,
      cardB.getAsNormalizedFullLink().id,
    );
    const itemC = c.getCellFromEntityId<{ seed: string }>(
      space,
      itemB.getAsNormalizedFullLink().id,
    );
    // C names the card and what it reads, so its upgrade runs at once.
    await cardC.sync();
    await itemC.sync();
    await quiesce(c);
    const upgradeTx = c.edit();
    c.runner.run(upgradeTx, cardV2, { item: itemC }, cardC);
    c.prepareTxForCommit(upgradeTx);
    expect((await upgradeTx.commit()).error).toBeUndefined();
    await quiesce(c);
    await c.storageManager.synced();
    await c.dispose({ closeStorage: false });
    runtimes.splice(runtimes.indexOf(c), 1);

    // B runs the card under the upgraded pattern, as its map would once the
    // pointer moved. The name B gave the card stands, so the marker C wrote
    // arrives as family and the run needs no hold; were the name gone, the
    // earlier landing was for the old pattern and the run is held again.
    // Either way the new handler runs on B.
    const cardV2B = await b.patternManager.compilePattern(CARD_V2_PROGRAM, {
      space,
    }) as Pattern;
    const runTx = b.edit();
    b.runner.run(runTx, cardV2B, { item: itemB }, cardB);
    b.prepareTxForCommit(runTx);
    expect((await runTx.commit()).error).toBeUndefined();
    await quiesce(b);
    expect(await send(cardB, "poke")).toBe(11);
    expect(errors.get(b)!.map((error) => error.message)).toEqual([]);
  });
});
