import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { SpaceReplica } from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { isRetryableCommitRejection } from "../src/storage/rejection.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("commit read basis");
const space = signer.did();

const valueSchema = {
  type: "object",
  properties: { value: { type: "number" } },
} as const;

const SHARED = "shared-doc";

describe("commit read basis", () => {
  // Two runtimes share one server whose fan-out runs only when a test flushes
  // it, so a frame can be delivered to the reader's replica at a chosen
  // point: after a transaction there has read a document, and before that
  // transaction commits. The transaction keeps the snapshot it read while
  // the replica moves on, and the commit's confirmed reads name the seqs the
  // replica holds when the commit is built. What ties those seqs to the
  // snapshot is the transaction's commit-time claim check, which re-reads
  // every snapshotted document from the replica and rejects the transaction
  // locally when a value differs — so a read set only reaches the wire when
  // its content is the content at the seqs it names.

  let server: MemoryV2Server.Server;
  let storageA: EmulatedStorageManager;
  let storageB: EmulatedStorageManager;
  let rtA: Runtime;
  let rtB: Runtime;

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
    storageA = EmulatedStorageManager.connectTo(server, { as: signer });
    storageB = EmulatedStorageManager.connectTo(server, { as: signer });
    rtA = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storageA,
    });
    rtB = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storageB,
    });
  });

  afterEach(async () => {
    await server.flushSessions([space]);
    await clock.settle();
    await rtB.dispose();
    await rtA.dispose();
    await storageB.close();
    await storageA.close();
    await server.close();
  });

  const sharedCellOf = (runtime: Runtime) =>
    runtime.getCell(space, SHARED, valueSchema);

  const sharedId = () => sharedCellOf(rtB).getAsNormalizedFullLink().id;

  const derivedOf = (runtime: Runtime, tx?: IExtendedStorageTransaction) =>
    runtime.getCell(space, "b-derived-doc", valueSchema, tx);

  // Runtime A creates the shared document and the server delivers it to
  // runtime B's replica, whose subscription the caller has set up.
  const createSharedFromA = async () => {
    const txA = rtA.edit();
    sharedCellOf(rtA).withTx(txA).set({ value: 42 });
    const created = await txA.commit({ resolveAt: "verdict" });
    expect(created.error).toBeUndefined();
    await server.flushSessions([space]);
    await clock.settle();
    await storageB.synced();
  };

  // Runtime B reads the shared document as absent inside `tx` and derives a
  // write from that, then the document lands in B's replica while `tx` stays
  // open.
  const readAbsentThenLand = async (): Promise<IExtendedStorageTransaction> => {
    const shared = sharedCellOf(rtB);
    await shared.sync();
    const tx = rtB.edit();
    expect(shared.withTx(tx).get()).toBeUndefined();
    derivedOf(rtB, tx).set({ value: 1 });
    await createSharedFromA();
    return tx;
  };

  describe("a document read as absent that another client creates before the commit", () => {
    it("is held by the replica while the open transaction still reads the absence", async () => {
      const tx = await readAbsentThenLand();
      expect(sharedCellOf(rtB).get()).toEqual({ value: 42 });
      expect(sharedCellOf(rtB).withTx(tx).get()).toBeUndefined();
      tx.abort("inspection only");
    });

    it("exports the confirmed read at the seq the replica holds when the commit is built", async () => {
      const tx = await readAbsentThenLand();
      const replica = storageB.open(space).replica as SpaceReplica;
      const exported = replica.accessForTestingOnly.buildReads(tx.tx, 1)
        .confirmed.find((read) => read.id === sharedId());
      expect(exported?.seq).toBeGreaterThan(0);
      tx.abort("inspection only");
    });

    it("rejects the commit locally as `StorageTransactionInconsistent`, which commit paths retry", async () => {
      const tx = await readAbsentThenLand();
      rtB.prepareTxForCommit(tx);
      const committed = await tx.commit({ resolveAt: "verdict" });
      expect(committed.error?.name).toBe("StorageTransactionInconsistent");
      expect(isRetryableCommitRejection(committed.error)).toBe(true);

      // The derived write never lands.
      await server.flushSessions([space]);
      await clock.settle();
      await storageB.synced();
      expect(derivedOf(rtB).get()).toBeUndefined();
    });
  });

  describe("a document whose own pending layer is confirmed before the commit", () => {
    it("is accepted, since the transaction's view included that layer", async () => {
      // B's first commit writes the shared document; its layer is pending
      // until the server's frame promotes it.
      const shared = sharedCellOf(rtB);
      const first = rtB.edit();
      shared.withTx(first).set({ value: 7 });
      const firstCommit = first.commit({ resolveAt: "verdict" });

      // The second transaction reads through that pending layer.
      const tx = rtB.edit();
      expect(shared.withTx(tx).get()).toEqual({ value: 7 });
      derivedOf(rtB, tx).set({ value: 2 });

      expect((await firstCommit).error).toBeUndefined();
      await server.flushSessions([space]);
      await clock.settle();
      await storageB.synced();

      rtB.prepareTxForCommit(tx);
      const committed = await tx.commit({ resolveAt: "verdict" });
      expect(committed.error).toBeUndefined();
    });
  });
});
