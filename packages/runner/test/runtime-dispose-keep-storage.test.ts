/**
 * `dispose({ closeStorage: false })`: tear the runtime down, leave the store.
 *
 * The shape this exists for is one store with two runtimes, where one of them
 * populates the store and something else READS the store afterwards — the
 * pattern-vintage capture runs a pattern's own tests against a file-backed
 * space and then snapshots the file (`tasks/pattern-vintage-run.ts`).
 *
 * The reason is OWNERSHIP, not breakage: a callee must not tear down a resource
 * its caller owns. Whether closing is survivable varies with who owns the
 * server behind the manager — `StorageManager.emulate` owns its own, so closing
 * it strands every later write, while a manager over a caller-held server
 * silently re-provisions and the writes land (both measured). "It recovered in
 * this configuration" is not a contract, so what is pinned here is the call
 * itself: `close()` happens on the default path and does not happen on this
 * one, and the store stays usable across the teardown.
 *
 * TWO storage managers over ONE in-process server, not two runtimes over one
 * manager. A replica belongs to its StorageManager, so two runtimes sharing one
 * read the same local heap and a read-back would pass against a store nothing
 * reached. Every claim here is about what reached the durable store, so the
 * reader sits behind a manager of its own.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import type { IStorageSubscription } from "../src/storage/interface.ts";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import {
  TEST_MEMORY_SERVER_AUTH,
  testPrincipalSessionOpenAuthFactory,
} from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("runtime dispose keep storage");
const space = signer.did();

const SCHEMA = {
  type: "object",
  properties: { value: { type: "number" } },
} as const;

class LoopbackSessionFactory implements SessionFactory {
  constructor(private readonly server: MemoryV2Server.Server) {}
  async create(id: string, signer?: Signer) {
    const client = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(this.server),
    });
    const session = await client.mount(
      id as MemorySpace,
      {},
      testPrincipalSessionOpenAuthFactory(signer),
    );
    return { client, session };
  }
}

/**
 * Counts `close()` calls, so "the runner closed my store" is asserted directly
 * rather than through a downstream symptom whose visibility depends on who owns
 * the server.
 */
class CountingStorageManager extends StorageManager {
  closeCount = 0;
  /** Subscribers currently registered. The relay inside exposes only
   * `hasSubscribers()`, and what a leak needs is the COUNT: two per runtime,
   * so "some are registered" cannot tell a clean teardown from a leaking one. */
  readonly live = new Set<IStorageSubscription>();
  static over(server: MemoryV2Server.Server): CountingStorageManager {
    return new CountingStorageManager(
      { as: signer, memoryHost: new URL("memory://") } as Options,
      new LoopbackSessionFactory(server),
    );
  }
  override close(): Promise<void> {
    this.closeCount++;
    return super.close();
  }
  override subscribe(subscription: IStorageSubscription): void {
    this.live.add(subscription);
    super.subscribe(subscription);
  }
  override unsubscribe(subscription: IStorageSubscription): void {
    this.live.delete(subscription);
    super.unsubscribe(subscription);
  }
}

describe("runtime.dispose({ closeStorage })", () => {
  let server: MemoryV2Server.Server;
  /** The store under test — handed to a runtime that does not own it. */
  let held: CountingStorageManager;
  /** An independent view of the same durable state, for witnessing writes. */
  let witness: CountingStorageManager;
  let witnessRuntime: Runtime;

  /** What the durable store holds for `cause`, read through `witness`. */
  const witnessed = async (cause: string) => {
    const cell = witnessRuntime.getCell<{ value: number }>(
      space,
      cause,
      SCHEMA,
    );
    await cell.sync();
    return cell.get();
  };

  const write = async (runtime: Runtime, cause: string, value: number) => {
    const tx = runtime.edit();
    runtime.getCell<{ value: number }>(space, cause, SCHEMA, tx).set({ value });
    await tx.commit();
    await runtime.idle();
  };

  beforeEach(() => {
    server = new MemoryV2Server.Server({
      authorizeSessionOpen(message) {
        const principal = (message.authorization as { principal?: unknown })
          ?.principal;
        return typeof principal === "string" ? principal : undefined;
      },
      sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
    });
    held = CountingStorageManager.over(server);
    witness = CountingStorageManager.over(server);
    witnessRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: witness,
    });
  });

  afterEach(async () => {
    await witnessRuntime.dispose();
    // Raised, not swallowed: `close()` is idempotent (measured — a double close
    // does not throw), so a rejection here is a real teardown failure.
    await held.close();
    await server.close();
  });

  it("leaves a caller-owned store alone and usable", async () => {
    const writer = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: held,
    });
    await write(writer, "dispose-keep-storage", 7);
    await held.synced();

    await writer.dispose({ closeStorage: false });

    expect(held.closeCount).toBe(0);
    expect(await witnessed("dispose-keep-storage")).toEqual({ value: 7 });

    // Still ACCEPTS writes — the capture's actual next move, which writes its
    // manifest through this same manager after the run returns. Witnessed
    // rather than read back locally, because the manager's own replica serves
    // a value back whether or not it reached the store.
    const second = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: held,
    });
    await write(second, "dispose-keep-storage-after", 8);
    await held.synced();
    expect(await witnessed("dispose-keep-storage-after")).toEqual({ value: 8 });

    await second.dispose({ closeStorage: false });
  });

  it("closes the store by default", async () => {
    const writer = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: held,
    });
    await write(writer, "dispose-closes", 7);
    await held.synced();

    await writer.dispose();

    // The paired assertion: without it `closeStorage` could be ignored in BOTH
    // directions and the case above would still pass.
    expect(held.closeCount).toBe(1);
    // What was already durable survives — closing is not a rollback.
    expect(await witnessed("dispose-closes")).toEqual({ value: 7 });
  });

  it("drains in-flight async builtin work before tearing down", async () => {
    // The hole this closes: a fetch / llm call or a sqlite RPC runs from a
    // post-commit outbox flush and writes its result back when it lands, and
    // `trackAsyncWork` exists precisely because `idle()` and `synced()` do not
    // wait for it. A store the caller keeps records that late writeback — after
    // `dispose()` claimed the runtime was done, and possibly after the caller
    // read the store.
    const writer = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: held,
    });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    const work = gate.then(async () => {
      await write(writer, "dispose-drains", 42);
      order.push("work");
    });
    writer.trackAsyncWork(work);

    const disposing = writer.dispose({ closeStorage: false })
      .then(() => order.push("dispose"));

    // A yield, not a timeout: `gate` cannot resolve until this test resolves
    // it, so no number of further turns changes the answer — a dispose that
    // drains is blocked forever, and one that does not has nothing left to
    // await (measured: a no-work dispose completes within one macrotask turn).
    // Verified by mutation: removing the drain reds this assertion, 10 of 10.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual([]);

    release();
    await disposing;
    // The writeback lands BEFORE dispose returns, so a caller that reads the
    // store afterwards sees the state this runtime actually reached.
    expect(order).toEqual(["work", "dispose"]);
    await held.synced();
    expect(await witnessed("dispose-drains")).toEqual({ value: 42 });
  });

  it("drains work that CHAINS past settled()'s default round cap", async () => {
    // One generation of tracked work is drained by a capped barrier too, so the
    // case above cannot see the cap. `settled()`'s default gives up after 50
    // rounds and returns with work outstanding — no throw, no signal — so a
    // drain that inherited it would re-open the hole for exactly the shape a
    // capture is likely to hit: an llm dialog with tool calls, or a fetch chain,
    // where each result registers the next piece of work.
    const GENERATIONS = 60;
    const writer = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: held,
    });

    let reached = 0;
    // Each generation registers the NEXT one and does not await it. That is
    // what costs a round: `settled()` awaits the set it snapshotted, and finds
    // a fresh entry waiting when it comes back. A chain whose head promise
    // transitively awaits the whole tail drains in ONE round instead and would
    // pass under the cap — measured, on the first version of this case.
    const spawn = () => {
      const work = new Promise<void>((resolve) => setTimeout(resolve, 0))
        .then(() => {
          reached++;
          if (reached < GENERATIONS) spawn();
        });
      writer.trackAsyncWork(work);
    };
    spawn();

    await writer.dispose({ closeStorage: false });

    // Verified by mutation: with `settled()` left at its default cap this reads
    // 50, and the chain is still running after dispose returned.
    expect(reached).toBe(GENERATIONS);
  });

  it("leaves no storage subscriber behind on a store it does not close", async () => {
    // `Scheduler` and `Runner` each register one at construction. `subscribe`
    // returns nothing, so the argument is the only handle there will ever be —
    // a subscription built inline is unreachable and can never be handed back.
    // Nor can it retire itself: both return `{ done: false }` unconditionally,
    // and `{ done: true }` is the contract's only self-cancelling answer.
    //
    // What is asserted is the CALLERS' half of the contract — that each keeps
    // its subscription and returns it — because that is the half in question.
    // `live` mirrors the subscribe/unsubscribe calls reaching the manager, not
    // the relay's membership: the relay is private and its `hasSubscribers()`
    // is not surfaced, and it would answer the wrong question anyway, reading
    // the same whether teardown was clean or leaked two per runtime.
    const baseline = new Set(held.live);
    const addedBy = (built: Set<IStorageSubscription>) =>
      [...held.live].filter((s) => !built.has(s));

    const first = new Runtime({
      apiUrl: new URL("memory://"),
      storageManager: held,
    });
    const firstPair = addedBy(baseline);
    expect(firstPair).toHaveLength(2);

    // The two runtimes OVERLAP, and the assertions name WHICH subscriptions are
    // handed back rather than how many. Sequential construct-dispose rounds
    // would not: neither round ever has another runtime's subscription to
    // return by mistake, so a disposal that gave back the wrong one still ends
    // at baseline.
    const second = new Runtime({
      apiUrl: new URL("memory://"),
      storageManager: held,
    });
    const secondPair = addedBy(new Set([...baseline, ...firstPair]));
    expect(secondPair).toHaveLength(2);

    await first.dispose({ closeStorage: false });
    expect(firstPair.filter((s) => held.live.has(s))).toEqual([]);
    expect(secondPair.filter((s) => held.live.has(s))).toEqual(secondPair);

    await second.dispose({ closeStorage: false });
    expect(secondPair.filter((s) => held.live.has(s))).toEqual([]);
    expect(held.live).toEqual(baseline);

    // Neither disposal closed the store, which is the option's whole point.
    expect(held.closeCount).toBe(0);
  });
});
