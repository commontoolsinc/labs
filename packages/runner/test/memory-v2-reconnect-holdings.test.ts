/**
 * The replica's statement of what it holds, end to end: a document the
 * runner synced is declared on the reconnect's `session.open` at the seq
 * the replica confirmed it at, so the server re-delivers only what the
 * replica lacks (04-protocol.md §4.1.2; `SpaceReplica.holdings`).
 */
import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { defer } from "@commonfabric/utils/defer";
import type { URI } from "@commonfabric/memory/interface";
import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  type SessionHolding,
} from "@commonfabric/memory/v2";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  SingleSessionFactory,
  TEST_MEMORY_SERVER_AUTH,
  testSessionOpenAuthFactory,
  TestStorageManager,
} from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("memory-v2-reconnect-holdings");
const space = signer.did();

type Sent = { type?: string; holdings?: SessionHolding[] };

/** A loopback transport over a real server that can drop its connection,
 * recording what the client sends. */
class DroppableTransport implements MemoryV2Client.Transport {
  readonly sent: Sent[] = [];
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #connection: ReturnType<MemoryV2Server.Server["connect"]> | null = null;

  constructor(private readonly server: MemoryV2Server.Server) {}

  async send(payload: string): Promise<void> {
    this.sent.push(decodeMemoryBoundary(payload) as Sent);
    await this.connection().receive(payload);
  }

  close(): Promise<void> {
    this.disconnect();
    return Promise.resolve();
  }

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  disconnect(): void {
    this.#connection?.close();
    this.#connection = null;
    queueMicrotask(() => this.#closeReceiver(new Error("disconnect")));
  }

  private connection(): ReturnType<MemoryV2Server.Server["connect"]> {
    if (this.#connection === null) {
      this.#connection = this.server.connect((message) => {
        this.#receiver(encodeMemoryBoundary(message));
      });
    }
    return this.#connection;
  }
}

describe("memory-v2 reconnect holdings", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it("declares a synced document at its confirmed seq on the reconnect", async () => {
    const server = new MemoryV2Server.Server({
      ...TEST_MEMORY_SERVER_AUTH,
      store: new URL(`memory://runner-v2-holdings-${crypto.randomUUID()}`),
    });
    const transport = new DroppableTransport(server);
    const storageManager = TestStorageManager.create({
      as: signer,
      memoryHost: new URL("memory://runner-v2-holdings"),
    }, new SingleSessionFactory(transport));
    const writerClient = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(server),
    });
    const writer = await writerClient.mount(
      space,
      {},
      testSessionOpenAuthFactory,
    );
    cleanups.push(
      () => storageManager.close(),
      () => writerClient.close(),
      () => server.close(),
    );
    const held = `of:memory-v2-held-${crypto.randomUUID()}` as URI;
    const never = `of:memory-v2-never-${crypto.randomUUID()}` as URI;
    await writer.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: held, value: { value: { held: 1 } } }],
    });
    const provider = storageManager.open(space);
    // One document the server has confirmed to this replica, one it has
    // only ever found absent: the first is a holding, the second is not.
    await provider.sync(held);
    await provider.sync(never);
    await storageManager.synced();

    const reopened = defer<SessionHolding[]>();
    const original = transport.send.bind(transport);
    transport.send = async (payload: string) => {
      await original(payload);
      const last = transport.sent.at(-1);
      if (last?.type === "session.open" && last.holdings !== undefined) {
        reopened.resolve(last.holdings);
      }
    };
    transport.disconnect();
    const holdings = await reopened.promise;

    const declared = holdings.find((holding) => holding.id === held);
    assert(declared !== undefined, "the synced document is declared");
    expect(declared.seq).toBeGreaterThan(0);
    expect(declared.deleted).toBeUndefined();
    expect(holdings.some((holding) => holding.id === never)).toBe(false);
  });
});
