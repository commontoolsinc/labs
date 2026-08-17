// Server-execution v2 fan-out stage A — OW17's instance-keyed replica and
// wire, the UNIT-level pins the E2E suite (executor-instance-keyed-
// replica.test.ts) rides on:
//
// - OFF-arm neutrality per re-keyed site: with no explicit instance
//   anywhere — every client, the whole OFF arm — the dependency key,
//   the compaction, the reactivity log, the notification addresses, and
//   the replica reads are byte-identical to the scope-NAME keying (the
//   `scopeKey` field is ABSENT, never `undefined`-valued);
// - the replica holds two instances of one doc: a seal under one
//   principal's identity leaves the other principal's — and the
//   replica's own — local doc untouched, and each identity reads its own;
// - the N-run loop resubscribes ONCE to the UNION of the instance logs:
//   after two instance runs, BOTH instances' reads are registered
//   (mutation: per-run resubscribe → only the last instance's read
//   survives);
// - two instance-named loads of one doc are two watches (distinct watch
//   ids), and the pull-kick reservation is per instance.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { resolveScopeKey } from "@commonfabric/memory/v2";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime, type ServerRunInfo } from "../src/runtime.ts";
import { stampWaveRunContext } from "../src/executor/wave.ts";
import { entityKey, entityNameKey } from "../src/scheduler/keys.ts";
import { sortAndCompactPaths } from "../src/reactive-dependencies.ts";
import { watchIdForEntry } from "../src/storage/v2-watch.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  MemorySpace,
  TransactionSealDestination,
} from "../src/storage/interface.ts";
import { txToReactivityLog } from "../src/scheduler/reactivity.ts";

const signer = await Identity.fromPassphrase("stage A instance keying");
const space = signer.did() as MemorySpace;
const alice = { principal: "did:key:z6Mk-stagea-alice", sessionId: "a-s1" };
const bob = { principal: "did:key:z6Mk-stagea-bob", sessionId: "b-s1" };

describe("stage A: instance keying — unit pins", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      servingPosture: true,
      experimental: { serverExecution: true },
    });
  });

  afterEach(async () => {
    runtime.clearSealDestination();
    await runtime.dispose();
    await storageManager.close();
  });

  it("OFF-arm neutrality: keys, compaction, and logged addresses without an explicit instance are byte-identical to the scope-NAME keying; an explicit instance is preferred where present", () => {
    const own = runtime.scopeKeyIdentity;
    const address: IMemorySpaceAddress = {
      space,
      id: "of:stagea-doc" as never,
      scope: "user",
      path: ["a"],
    };
    // Without `scopeKey`: exactly the pre-stage-A string.
    expect(entityKey(address, own)).toBe(
      `${space}/${resolveScopeKey("user", own)}/of:stagea-doc`,
    );
    // With one: the instance, the identity not consulted.
    expect(entityKey({ ...address, scopeKey: "user:x" }, own)).toBe(
      `${space}/user:x/of:stagea-doc`,
    );
    // The name-keyed twin (the writer/materializer index) ignores both.
    expect(entityNameKey({ ...address, scopeKey: "user:x" })).toBe(
      `${space}/user/of:stagea-doc`,
    );
    expect(entityNameKey(address)).toBe(entityNameKey({ ...address }));

    // Compaction: two name-equal reads compact as before; two reads of
    // DIFFERENT instances stay apart (the union of an N-run loop's logs).
    const compacted = sortAndCompactPaths([
      { ...address, path: ["a"] },
      { ...address, path: ["a", "b"] },
    ]);
    expect(compacted.length).toBe(1);
    expect(Object.hasOwn(compacted[0], "scopeKey")).toBe(false);
    const twoInstances = sortAndCompactPaths([
      { ...address, scopeKey: resolveScopeKey("user", alice) },
      { ...address, scopeKey: resolveScopeKey("user", bob) },
    ]);
    expect(twoInstances.length).toBe(2);
    expect(
      twoInstances.map((read) => read.scopeKey).toSorted(),
    ).toEqual(
      [resolveScopeKey("user", alice), resolveScopeKey("user", bob)]
        .toSorted(),
    );
  });

  it("OFF-arm neutrality: a transaction with no run identity logs addresses without any `scopeKey` property; a stamped run's SCOPED reads carry its instance and its space reads do not", () => {
    const cell = runtime.getCell<{ value: number }>(
      space,
      "stagea-log-scoped",
      undefined,
      undefined,
      "user",
    );
    const spaceCell = runtime.getCell<{ value: number }>(
      space,
      "stagea-log-space",
      undefined,
    );
    // Unstamped (every client, the OFF arm).
    const plain = runtime.edit();
    cell.withTx(plain).get();
    spaceCell.withTx(plain).get();
    const plainLog = txToReactivityLog(plain);
    expect(plainLog.reads.length).toBeGreaterThan(0);
    for (const read of plainLog.reads) {
      expect(Object.hasOwn(read, "scopeKey")).toBe(false);
    }
    expect(plain.tx.scopeKeyIdentity).toBeUndefined();
    plain.abort();

    // Stamped as Alice (a served per-instance run).
    const stamped = runtime.edit();
    stampWaveRunContext(stamped, {
      actionId: "stagea-log",
      kind: "derivation",
      scopeKeyIdentity: alice,
      actionScopeKey: resolveScopeKey("user", alice),
    });
    expect(stamped.tx.scopeKeyIdentity).toEqual(alice);
    cell.withTx(stamped).get();
    spaceCell.withTx(stamped).get();
    const stampedLog = txToReactivityLog(stamped);
    const scopedReads = stampedLog.reads.filter((read) =>
      read.scope === "user"
    );
    const spaceReads = stampedLog.reads.filter((read) =>
      (read.scope ?? "space") === "space"
    );
    expect(scopedReads.length).toBeGreaterThan(0);
    for (const read of scopedReads) {
      expect(read.scopeKey).toBe(resolveScopeKey("user", alice));
    }
    expect(spaceReads.length).toBeGreaterThan(0);
    for (const read of spaceReads) {
      expect(Object.hasOwn(read, "scopeKey")).toBe(false);
    }
    // One identity per transaction: a DIFFERENT identity is refused.
    expect(() => {
      stamped.tx.scopeKeyIdentity = bob;
    }).toThrow(/one transaction serves one identity/);
    // The same identity again is idempotent.
    stamped.tx.scopeKeyIdentity = { ...alice };
    stamped.abort();
  });

  it("the replica holds two instances of one doc: a seal as Alice leaves Bob's and the replica's own local doc untouched, and each identity reads its own (the R7 read shape at the replica level)", async () => {
    const replica = storageManager.open(space).replica;
    // Own-identity write (the OFF path): lands in the replica's own
    // instance only.
    const ownCell = runtime.getCell<{ value: string }>(
      space,
      "stagea-two-instances-cell",
      undefined,
      undefined,
      "user",
    );
    const ownTx = runtime.edit();
    ownCell.withTx(ownTx).set({ value: "own" });
    expect((await ownTx.commit()).error).toBeUndefined();
    const docId = ownCell.getAsNormalizedFullLink().id;
    const readAs = (identity: typeof alice | undefined) =>
      (replica.getDocument(docId, "user", identity)?.value as
        | { value?: string }
        | undefined)?.value;
    expect(readAs(undefined)).toBe("own");
    expect(readAs(runtime.scopeKeyIdentity)).toBe("own");
    expect(readAs(alice)).toBeUndefined();
    expect(readAs(bob)).toBeUndefined();

    // A seal under Alice's identity through the wave stamp: the pending
    // layer lands on ALICE's instance and nowhere else.
    const seals: IExtendedStorageTransaction[] = [];
    const destination: TransactionSealDestination = {
      seal: (tx) => {
        seals.push(tx);
        return tx.tx.commit();
      },
    };
    runtime.installSealDestination(destination, {
      runStamper: (tx: IExtendedStorageTransaction, info: ServerRunInfo) => {
        stampWaveRunContext(tx, {
          actionId: info.actionId,
          kind: info.kind,
          scopeKeyIdentity: alice,
          actionScopeKey: resolveScopeKey("user", alice),
        });
      },
    });
    // Drive the write through the replica's own sealNative with the
    // identity option — the exact seam the wave uses.
    const aliceTx = runtime.edit();
    stampWaveRunContext(aliceTx, {
      actionId: "stagea-seal-alice",
      kind: "derivation",
      scopeKeyIdentity: alice,
      actionScopeKey: resolveScopeKey("user", alice),
    });
    const { promise, resolve } = Promise.withResolvers<
      { committed: { seq: number } }
    >();
    const sealed = replica.sealNative!(
      {
        operations: [{
          op: "set",
          id: docId,
          type: "application/json",
          scope: "user",
          value: { value: { value: "alice-pending" } } as never,
        }],
        preconditions: [],
      } as never,
      aliceTx.tx,
      promise,
      { identity: alice },
    );
    expect(sealed.localSeq).toBeGreaterThan(0);
    // Visible through Alice's instance, invisible to Bob and to the
    // replica's own instance.
    expect(readAs(alice)).toBe("alice-pending");
    expect(readAs(bob)).toBeUndefined();
    expect(readAs(undefined)).toBe("own");
    // The verdict confirms exactly Alice's layer (F1a: sealed commits
    // confirm at verdict), still keyed apart from the replica's own.
    resolve({ committed: { seq: 999 } } as never);
    await sealed.settled;
    expect(readAs(alice)).toBe("alice-pending");
    expect(readAs(undefined)).toBe("own");
    expect(readAs(bob)).toBeUndefined();
    aliceTx.abort();
    runtime.clearSealDestination();
  });

  it("the N-run loop resubscribes ONCE to the union of its instance logs: after two instance runs both instances' reads are registered (mutation: per-run replacement keeps only the last)", async () => {
    const rootId = "of:stagea-union-root";
    runtime.installSealDestination(
      { seal: (tx: IExtendedStorageTransaction) => tx.tx.commit() },
      {
        runStamper: (
          tx: IExtendedStorageTransaction,
          info: ServerRunInfo,
        ) => {
          stampWaveRunContext(tx, {
            actionId: info.actionId,
            kind: info.kind,
            ...(info.scopeKeyIdentity !== undefined
              ? { scopeKeyIdentity: info.scopeKeyIdentity }
              : {}),
            ...(info.actionScopeKey !== undefined
              ? { actionScopeKey: info.actionScopeKey }
              : {}),
          });
        },
        runInstanceResolver: (pieceRootIds) =>
          pieceRootIds.includes(rootId)
            ? [
              {
                scopeKeyIdentity: alice,
                actionScopeKey: resolveScopeKey("user", alice),
              },
              {
                scopeKeyIdentity: bob,
                actionScopeKey: resolveScopeKey("user", bob),
              },
            ]
            : [],
      },
    );
    const scoped = runtime.getCell<{ value: number }>(
      space,
      "stagea-union-input",
      undefined,
      undefined,
      "user",
    );
    const action = Object.assign(
      (tx: IExtendedStorageTransaction) => {
        // Each instance run reads ITS instance of the scoped input.
        scoped.withTx(tx).get();
      },
      {
        schedulerObservationIdentity: {
          pieceId: `space:${rootId}`,
          pieceRootId: rootId,
        },
      },
    );
    await runtime.scheduler.run(action);
    await runtime.idle();

    const inputId = scoped.getAsNormalizedFullLink().id;
    const snapshot = runtime.scheduler.getGraphSnapshot();
    const node = snapshot.nodes.find((candidate) =>
      candidate.reads?.some((read) => read.includes(inputId))
    );
    expect(node).toBeDefined();
    const inputReads = node!.reads!.filter((read) => read.includes(inputId));
    // BOTH instances registered — the union.
    expect(
      inputReads.some((read) => read.includes(resolveScopeKey("user", alice))),
    ).toBe(true);
    expect(
      inputReads.some((read) => read.includes(resolveScopeKey("user", bob))),
    ).toBe(true);
    // And the graph stays SINGULAR: one node for the action (C11b).
    expect(
      snapshot.nodes.filter((candidate) =>
        candidate.reads?.some((read) => read.includes(inputId))
      ).length,
    ).toBe(1);
  });

  it("two instance-named loads of one doc are two watches, and the pull-kick reservation is per instance", () => {
    const address = {
      id: "of:stagea-watch" as never,
      type: "application/json" as const,
      scope: "user" as const,
    };
    const selector = { path: [], schema: false as const };
    const plain = watchIdForEntry(address, selector, "");
    const asAlice = watchIdForEntry(
      { ...address, scopeKey: resolveScopeKey("user", alice) },
      selector,
      "",
    );
    const asBob = watchIdForEntry(
      { ...address, scopeKey: resolveScopeKey("user", bob) },
      selector,
      "",
    );
    expect(asAlice).not.toBe(asBob);
    expect(asAlice).not.toBe(plain);
    // An unnamed entry's id is independent of the field's existence.
    expect(watchIdForEntry({ ...address, scopeKey: undefined }, selector, ""))
      .toBe(plain);

    // The manager reserves one kick per (space, instance, id).
    expect(storageManager.shouldPullDoc(space, address.id, "user", alice))
      .toBe(true);
    expect(storageManager.shouldPullDoc(space, address.id, "user", alice))
      .toBe(false);
    expect(storageManager.shouldPullDoc(space, address.id, "user", bob))
      .toBe(true);
    // The own-identity reservation is a distinct key from either.
    expect(storageManager.shouldPullDoc(space, address.id, "user")).toBe(true);
  });
});
