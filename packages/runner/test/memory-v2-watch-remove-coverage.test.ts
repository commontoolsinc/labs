// Deterministic coverage for the "removes" arm of applySessionSync in
// storage/v2.ts. A watch refresh / sync batch can carry removals when a watched
// doc is deleted upstream. Most tests only deliver upserts, so the removes path
// runs intermittently. Here the scripted transport answers the watch.add with a
// sync that upserts two docs and removes one of them in the same batch, so the
// removes loop always runs while provider.sync() is awaited.

import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import type { URI } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  type EntityDocument,
  getMemoryProtocolFlags,
  type SessionSync,
  type SessionSyncUpsert,
} from "@commonfabric/memory/v2";
import type { IStorageProviderWithReplica } from "../src/storage/interface.ts";
import {
  SingleSessionFactory,
  TestStorageManager,
} from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("memory-v2-watch-remove-coverage");
const space = signer.did();
const HELLO_OK = {
  type: "hello.ok",
  protocol: "memory",
  flags: getMemoryProtocolFlags(),
} as const;

type TestProvider = IStorageProviderWithReplica & {
  get(uri: URI): EntityDocument | undefined;
  sync(
    uri: URI,
    selector?: { path: string[]; schema: unknown },
  ): Promise<unknown>;
};

const doc = (
  id: URI,
  seq: number,
  doc: SessionSyncUpsert["doc"],
): SessionSyncUpsert => ({
  branch: "",
  id,
  seq,
  doc,
});

const getObjectValue = (
  provider: TestProvider,
  uri: URI,
): Record<string, unknown> | undefined => {
  const value = provider.get(uri)?.value;
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
};

// Answers the watch.add with a sync that upserts every requested root and then
// removes `removedId` in the same batch, simulating a watched doc deleted
// upstream as the watch is established.
class WatchAddRemoveTransport implements MemoryV2Client.Transport {
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};

  constructor(private readonly removedId: URI) {}

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  send(payload: string): Promise<void> {
    const message = decodeMemoryBoundary(payload) as {
      type: string;
      requestId?: string;
      watches?: Array<{
        query?: { roots?: Array<{ id: string }> };
      }>;
    };

    switch (message.type) {
      case "hello":
        this.#respond(HELLO_OK);
        return Promise.resolve();
      case "session.open":
        this.#respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            sessionId: "session:watch-remove-coverage",
            serverSeq: 0,
          },
        });
        return Promise.resolve();
      case "session.ack":
        this.#respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            serverSeq: 5,
          },
        });
        return Promise.resolve();
      case "session.watch.add": {
        const roots =
          message.watches?.flatMap((watch) =>
            watch.query?.roots?.map((root) => root.id as URI) ?? []
          ) ?? [];
        const toSeq = roots.length + 1;
        this.#respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            serverSeq: toSeq,
            sync: {
              type: "sync",
              fromSeq: 0,
              toSeq,
              upserts: roots.map((id, index) =>
                doc(id, index + 1, { value: { label: id } })
              ),
              removes: [{ branch: "", id: this.removedId }],
            } satisfies SessionSync,
          },
        });
        return Promise.resolve();
      }
      default:
        throw new Error(`Unhandled scripted message: ${message.type}`);
    }
  }

  close(): Promise<void> {
    this.#closeReceiver();
    return Promise.resolve();
  }

  #respond(message: FabricValue): void {
    this.#receiver(encodeMemoryBoundary(message));
  }
}

Deno.test("memory v2 runner applies removes carried in a watch refresh batch", async () => {
  const docA = `of:watch-remove-keep-${crypto.randomUUID()}` as URI;
  const docB = `of:watch-remove-drop-${crypto.randomUUID()}` as URI;
  const transport = new WatchAddRemoveTransport(docB);
  const sessionFactory = new SingleSessionFactory(transport);
  const storageManager = TestStorageManager.create({
    as: signer,
    memoryHost: new URL("memory://runner-v2-watch-remove-coverage"),
  }, sessionFactory);
  const provider = storageManager.open(space) as TestProvider;

  try {
    await Promise.all([
      provider.sync(docA, { path: [], schema: false }),
      provider.sync(docB, { path: [], schema: false }),
    ]);

    // docA was upserted and kept; docB was upserted in the same sync and then
    // removed, so the removes loop must have reset it back to absent.
    assertEquals(getObjectValue(provider, docA), { label: docA });
    assertEquals(provider.get(docB), undefined);
  } finally {
    await storageManager.close();
  }
});
