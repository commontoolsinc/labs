import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  ExecutionLeaseCycle,
  executionLeaseHolder,
} from "@commonfabric/memory/v2/execution-lease";
import { resolveScopeKey } from "@commonfabric/memory/v2";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type {
  IExtendedStorageTransaction,
  IStorageTransaction,
} from "../src/storage/interface.ts";
import { stampWaveRunContext } from "../src/executor/wave.ts";
import { excludeReadFromConflict } from "../src/storage/reactivity-log.ts";
import { toMemorySpaceAddress } from "../src/link-types.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("absence reconciliation test");
const space = signer.did();

const valueSchema = {
  type: "object",
  properties: { value: { type: "number" } },
} as const;

describe("editWithRetry absence reconciliation", () => {
  // A transaction that reads a document this replica never synced records an
  // absence, which the commit would export as a `seq: 0` confirmed read — a
  // claim the engine rejects whenever the document exists. `editWithRetry`
  // loads such documents before committing and re-runs its action locally
  // when any turn out to exist, so convergence costs local rounds instead of
  // wire rejections. These tests pin the local path apart from the wire path
  // by whether the conflict machinery (`awaitCommitRetryReadiness`) is ever
  // consulted: both paths converge to the same result, only one of them
  // round-trips a doomed commit to get there.
  it("re-runs locally against a document another client already wrote, without a wire conflict", async () => {
    const server = newSharedServer();
    const smA = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtimeA = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: smA,
    });
    let smB: EmulatedStorageManager | undefined;
    let runtimeB: Runtime | undefined;
    try {
      // Client A creates the document and settles it server-side.
      const txA = runtimeA.edit();
      runtimeA.getCell(space, "shared-absence-doc", valueSchema, txA)
        .set({ value: 42 });
      await txA.commit();
      await smA.synced();

      // Client B is a cold replica of the same space.
      smB = EmulatedStorageManager.connectTo(server, { as: signer });
      runtimeB = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: smB,
      });
      let readinessConsulted = 0;
      const readiness = runtimeB.awaitCommitRetryReadiness.bind(runtimeB);
      runtimeB.awaitCommitRetryReadiness = (error: unknown) => {
        readinessConsulted++;
        return readiness(error);
      };

      let runs = 0;
      let observed: { value?: number } | undefined;
      const result = await runtimeB.editWithRetry((tx) => {
        runs++;
        // Reads the foreign document cold: absent on the first run, so the
        // read would commit as an absence claim over an existing document.
        observed = runtimeB!.getCell(
          space,
          "shared-absence-doc",
          valueSchema,
          tx,
        ).get();
        runtimeB!.getCell(space, "b-own-doc", valueSchema, tx)
          .set({ value: runs });
      });

      expect(result.error).toBeUndefined();
      // One local re-run: the loaded document changes what the action reads.
      expect(runs).toBe(2);
      expect(observed).toEqual({ value: 42 });
      // The discriminator: convergence never consulted the wire-conflict
      // machinery. Without the pre-commit load, the same outcome arrives via
      // a rejected commit and this counter.
      expect(readinessConsulted).toBe(0);
    } finally {
      await runtimeB?.dispose();
      await runtimeA.dispose();
      await smB?.close();
      await smA.close();
      await server.close();
    }
  });

  it("commits on the first run when the absent documents are absent everywhere", async () => {
    const server = newSharedServer();
    const sm = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm,
    });
    try {
      let runs = 0;
      const result = await runtime.editWithRetry((tx) => {
        runs++;
        // A document nobody ever wrote: the absence is sound, so it commits
        // as an examined absence rather than forcing a re-run.
        runtime.getCell(space, "never-written-doc", valueSchema, tx).get();
        runtime.getCell(space, "own-doc", valueSchema, tx).set({ value: 1 });
      });

      expect(result.error).toBeUndefined();
      expect(runs).toBe(1);
    } finally {
      await runtime.dispose();
      await sm.close();
      await server.close();
    }
  });

  it("removes the temporary watch after confirming an absence", async () => {
    const server = newSharedServer();
    const readerStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const readerRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: readerStorage,
    });
    let writerStorage: EmulatedStorageManager | undefined;
    let writerRuntime: Runtime | undefined;
    let probedAddress:
      | ReturnType<typeof toMemorySpaceAddress>
      | undefined;
    try {
      const result = await readerRuntime.editWithRetry((tx) => {
        const probed = readerRuntime.getCell(
          space,
          "temporary-absence-watch-doc",
          valueSchema,
          tx,
        );
        probedAddress = toMemorySpaceAddress(probed.getAsNormalizedFullLink());
        tx.read(probedAddress, { trackReadWithoutLoad: true });
        readerRuntime.getCell(
          space,
          "temporary-absence-watch-output",
          valueSchema,
          tx,
        ).set({ value: 1 });
      });
      expect(result.error).toBeUndefined();

      // Create the probed document only after the absence transaction has
      // committed. If reconciliation retained its one-shot watch, this later
      // update would be pushed into the reader's replica.
      writerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
      writerRuntime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: writerStorage,
      });
      const create = writerRuntime.edit();
      writerRuntime.getCell(
        space,
        "temporary-absence-watch-doc",
        valueSchema,
        create,
      ).set({ value: 9 });
      expect((await create.commit()).error).toBeUndefined();
      await writerStorage.synced();
      await server.flushSessions([space]);
      await readerStorage.synced();

      expect(
        readerStorage.open(space).replica.getDocument(
          probedAddress!.id,
          probedAddress!.scope,
        ),
      ).toBeUndefined();
    } finally {
      await writerRuntime?.dispose();
      await readerRuntime.dispose();
      await writerStorage?.close();
      await readerStorage.close();
      await server.close();
    }
  });

  it("does not reconcile reads excluded from the commit conflict set", async () => {
    const server = newSharedServer();
    const writerStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const writerRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: writerStorage,
    });
    let readerStorage: EmulatedStorageManager | undefined;
    let readerRuntime: Runtime | undefined;
    try {
      const excludedAddress = {
        space,
        id: "of:excluded-cold-read-doc" as const,
        type: "application/json" as const,
        scope: "space" as const,
        path: [] as string[],
      };
      const seed = writerRuntime.edit();
      seed.writeValueOrThrow(excludedAddress, { value: 17 });
      expect((await seed.commit()).error).toBeUndefined();
      await writerStorage.synced();

      readerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
      readerRuntime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: readerStorage,
      });
      let runs = 0;
      const result = await readerRuntime.editWithRetry((tx) => {
        runs++;
        tx.read(
          excludedAddress,
          {
            meta: excludeReadFromConflict,
            nonRecursive: true,
            trackReadWithoutLoad: true,
          },
        );
        readerRuntime!.getCell(
          space,
          "excluded-cold-read-output",
          valueSchema,
          tx,
        ).set({ value: runs });
      });

      expect(result.error).toBeUndefined();
      expect(runs).toBe(1);
      expect(
        readerStorage.open(space).replica.getDocument(
          excludedAddress.id,
          excludedAddress.scope,
        ),
      ).toBeUndefined();
    } finally {
      await readerRuntime?.dispose();
      await writerRuntime.dispose();
      await readerStorage?.close();
      await writerStorage.close();
      await server.close();
    }
  });

  it("falls back to the commit verdict when reconciliation providers fail", async () => {
    const server = newSharedServer();
    const sm = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm,
    });
    const provider = sm.open(space);
    const original = provider.loadUnexaminedAbsences;
    try {
      const failures = [
        () => {
          throw new Error("synchronous reconciliation failure");
        },
        () => Promise.reject(new Error("asynchronous reconciliation failure")),
      ];
      for (let index = 0; index < failures.length; index++) {
        provider.loadUnexaminedAbsences = failures[index];
        let runs = 0;
        const result = await runtime.editWithRetry((tx) => {
          runs++;
          runtime.getCell(
            space,
            `provider-failure-cold-${index}`,
            valueSchema,
            tx,
          ).get();
          runtime.getCell(
            space,
            `provider-failure-output-${index}`,
            valueSchema,
            tx,
          ).set({ value: 1 });
        });
        expect(result.error).toBeUndefined();
        expect(runs).toBe(1);
      }

      // The capability is optional. A provider that predates absence
      // reconciliation must retain the original server-judged commit path.
      provider.loadUnexaminedAbsences = undefined;
      const result = await runtime.editWithRetry((tx) => {
        runtime.getCell(
          space,
          "provider-without-reconciliation-capability",
          valueSchema,
          tx,
        ).get();
        runtime.getCell(
          space,
          "provider-without-reconciliation-output",
          valueSchema,
          tx,
        ).set({ value: 1 });
      });
      expect(result.error).toBeUndefined();
    } finally {
      provider.loadUnexaminedAbsences = original;
      await runtime.dispose();
      await sm.close();
      await server.close();
    }
  });

  it("aborts an edit when disposal begins inside its action", async () => {
    const server = newSharedServer();
    const sm = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm,
    });
    let disposing: Promise<void> | undefined;
    try {
      const result = await runtime.editWithRetry((tx) => {
        runtime.getCell(
          space,
          "dispose-before-edit-commit",
          valueSchema,
          tx,
        ).set({ value: 1 });
        // The closing path sets the write gate synchronously before its first
        // awaited teardown barrier. editWithRetry must abort this prepared
        // transaction instead of committing behind disposal.
        disposing = runtime.dispose();
      });

      expect(result.error?.name).toBe("StorageTransactionAborted");
      expect(result.error?.message).toContain("runtime is disposing");
      await disposing;
    } finally {
      await disposing?.catch(() => undefined);
      await sm.close();
      await server.close();
    }
  });

  it("returns a transaction error when commit rejects its promise", async () => {
    const server = newSharedServer();
    const sm = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm,
    });
    const failure = new Error("synthetic commit rejection");
    let attempted: IExtendedStorageTransaction | undefined;
    try {
      const result = await runtime.editWithRetry((tx) => {
        attempted = tx;
        tx.commit = (() => Promise.reject(failure)) as typeof tx.commit;
        return "uncommitted";
      }, 0);

      expect(result.error?.name).toBe("StorageTransactionAborted");
      expect(result.error?.message).toContain("synthetic commit rejection");
      expect((result.error as { reason?: unknown } | undefined)?.reason).toBe(
        failure,
      );
    } finally {
      attempted?.abort("synthetic commit completed");
      await runtime.dispose();
      await sm.close();
      await server.close();
    }
  });

  it("cancels a retry readiness wait when kept-storage disposal begins", async () => {
    const server = newSharedServer();
    const sm = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm,
    });
    const readiness = Promise.withResolvers<void>();
    const waiting = Promise.withResolvers<void>();
    let editing: ReturnType<Runtime["editWithRetry"]> | undefined;
    let disposed = false;
    try {
      editing = runtime.editWithRetry((tx) => {
        tx.commit = (() =>
          Promise.resolve({
            error: {
              name: "ConflictError",
              message: "synthetic conflict with a stuck catch-up gate",
              readyToRetry: () => {
                waiting.resolve();
                return readiness.promise;
              },
            },
          })) as typeof tx.commit;
      });
      await waiting.promise;

      await runtime.dispose({ closeStorage: false });
      disposed = true;

      const timeout = Symbol("retry readiness timeout");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        editing,
        new Promise<typeof timeout>((resolve) => {
          timer = setTimeout(() => resolve(timeout), 250);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      expect(outcome).not.toBe(timeout);
      if (outcome !== timeout) {
        expect(outcome.error?.name).toBe("StorageTransactionAborted");
        expect(outcome.error?.message).toContain("runtime is disposing");
      }
    } finally {
      readiness.resolve();
      await editing?.catch(() => undefined);
      if (!disposed) await runtime.dispose({ closeStorage: false });
      await sm.close();
      await server.close();
    }
  });

  it("does not resume a reconciled edit after runtime disposal", async () => {
    const server = newSharedServer();
    const sm = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm,
    });
    const provider = sm.open(space);
    const original = provider.loadUnexaminedAbsences;
    const reconciliation = Promise.withResolvers<number>();
    let reconciliationCalled = false;
    let disposed = false;
    let outputAddress:
      | ReturnType<typeof toMemorySpaceAddress>
      | undefined;
    try {
      provider.loadUnexaminedAbsences = () => {
        reconciliationCalled = true;
        return reconciliation.promise;
      };
      const editing = runtime.editWithRetry((tx) => {
        runtime.getCell(
          space,
          "dispose-during-reconciliation-input",
          valueSchema,
          tx,
        ).get();
        const output = runtime.getCell(
          space,
          "dispose-during-reconciliation-output",
          valueSchema,
          tx,
        );
        outputAddress = toMemorySpaceAddress(
          output.getAsNormalizedFullLink(),
        );
        output.set({ value: 1 });
      });
      expect(reconciliationCalled).toBe(true);

      await runtime.dispose({ closeStorage: false });
      disposed = true;
      reconciliation.resolve(0);
      const result = await editing;

      expect(result.error?.name).toBe("StorageTransactionAborted");
      expect(
        provider.replica.getDocument(
          outputAddress!.id,
          outputAddress!.scope,
        ),
      ).toBeUndefined();
    } finally {
      provider.loadUnexaminedAbsences = original;
      reconciliation.resolve(0);
      if (!disposed) await runtime.dispose({ closeStorage: false });
      await sm.close();
      await server.close();
    }
  });

  it("reconciles the served transaction's user and session instances", async () => {
    const actor = await Identity.fromPassphrase(
      "absence reconciliation served actor",
    );
    const service = await Identity.fromPassphrase(
      "absence reconciliation serving runtime",
    );
    const actorIdentity = {
      principal: actor.did(),
      sessionId: "absence-actor-session",
    };
    const server = newSharedServer();
    let actorStorage: EmulatedStorageManager | undefined =
      EmulatedStorageManager.connectTo(server, {
        as: actor,
        id: actorIdentity.sessionId,
      });
    let actorRuntime: Runtime | undefined = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: actorStorage,
    });
    let servingStorage: EmulatedStorageManager | undefined;
    let servingRuntime: Runtime | undefined;
    let lease: ExecutionLeaseCycle | undefined;
    try {
      const userCell = actorRuntime.getCell<{ value: number }>(
        space,
        "served-identity-user",
        valueSchema,
        undefined,
        "user",
      );
      const sessionCell = actorRuntime.getCell<{ value: number }>(
        space,
        "served-identity-session",
        valueSchema,
        undefined,
        "session",
      );
      const seed = actorRuntime.edit();
      userCell.withTx(seed).set({ value: 11 });
      sessionCell.withTx(seed).set({ value: 22 });
      expect((await seed.commit()).error).toBeUndefined();
      await actorStorage.synced();
      const userId = userCell.getAsNormalizedFullLink().id;
      const sessionId = sessionCell.getAsNormalizedFullLink().id;
      await actorRuntime.dispose();
      actorRuntime = undefined;
      await actorStorage.close();
      actorStorage = undefined;

      const holder = executionLeaseHolder(service.did());
      servingStorage = EmulatedStorageManager.connectTo(server, {
        as: service,
        id: holder,
        servingHomeSpace: space,
      });
      servingRuntime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: servingStorage,
        servingPosture: true,
        experimental: { serverExecution: true },
      });
      const engine = await server.engineForSpace(space);
      lease = new ExecutionLeaseCycle({ engine, space, holder });
      expect(lease.acquire()).toBe(true);

      const tx = servingRuntime.edit();
      stampWaveRunContext(tx, {
        actionId: "reconcile-served-identity",
        kind: "derivation",
        scopeKeyIdentity: actorIdentity,
        actionScopeKey: resolveScopeKey("user", actorIdentity),
      });
      tx.read({
        space,
        id: userId,
        type: "application/json",
        scope: "user",
        path: [],
      }, { trackReadWithoutLoad: true });
      tx.read({
        space,
        id: sessionId,
        type: "application/json",
        scope: "session",
        path: [],
      }, { trackReadWithoutLoad: true });

      const provider = servingStorage.open(space);
      expect(await provider.loadUnexaminedAbsences!(tx.tx)).toBe(2);
      expect(
        (provider.replica.getDocument(userId, "user", actorIdentity)?.value as
          | { value?: number }
          | undefined)?.value,
      ).toBe(11);
      expect(
        (provider.replica.getDocument(
          sessionId,
          "session",
          actorIdentity,
        )?.value as { value?: number } | undefined)?.value,
      ).toBe(22);
      expect(provider.replica.getDocument(userId, "user")).toBeUndefined();
      expect(provider.replica.getDocument(sessionId, "session"))
        .toBeUndefined();
      tx.abort("inspection only");
    } finally {
      lease?.release();
      await servingRuntime?.dispose();
      await actorRuntime?.dispose();
      await servingStorage?.close();
      await actorStorage?.close();
      await server.close();
    }
  });

  it("reports through the provider how many unexamined absences exist", async () => {
    const server = newSharedServer();
    const smA = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtimeA = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: smA,
    });
    let smB: EmulatedStorageManager | undefined;
    let runtimeB: Runtime | undefined;
    try {
      const txA = runtimeA.edit();
      runtimeA.getCell(space, "provider-level-doc", valueSchema, txA)
        .set({ value: 7 });
      await txA.commit();
      await smA.synced();

      smB = EmulatedStorageManager.connectTo(server, { as: signer });
      runtimeB = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: smB,
      });
      const txB = runtimeB.edit();
      runtimeB.getCell(space, "provider-level-doc", valueSchema, txB).get();
      runtimeB.getCell(space, "provider-level-absent", valueSchema, txB).get();

      const provider = smB.open(space);
      expect(provider.loadUnexaminedAbsences).toBeDefined();
      expect(await provider.loadUnexaminedAbsences!(undefined)).toBe(0);
      expect(
        await provider.loadUnexaminedAbsences!({
          getReadActivities: () => undefined,
        } as unknown as IStorageTransaction),
      ).toBe(0);

      // A write in another space is irrelevant to this replica's own-write
      // exclusion, and must be skipped rather than keyed here.
      const otherSpace = (await Identity.fromPassphrase(
        "absence reconciliation unrelated space",
      )).did();
      runtimeB.getCell(otherSpace, "unrelated-write", valueSchema, txB)
        .set({ value: 1 });
      // Of the two cold reads, exactly one document turns out to exist; the
      // other's absence is examined and stays a sound claim.
      expect(await provider.loadUnexaminedAbsences!(txB.tx)).toBe(1);
      // Loaded is loaded: a second pass finds nothing left unexamined.
      expect(await provider.loadUnexaminedAbsences!(txB.tx)).toBe(0);
      txB.abort("inspection only");

      // A partial served identity cannot name a session instance on the wire.
      // Leave that absence for ordinary commit admission.
      const incomplete = runtimeB.edit();
      incomplete.tx.scopeKeyIdentity = { principal: signer.did() };
      incomplete.read({
        space,
        id: "of:incomplete-served-session-identity",
        type: "application/json",
        scope: "session",
        path: [],
      }, { trackReadWithoutLoad: true });
      expect(await provider.loadUnexaminedAbsences!(incomplete.tx)).toBe(0);
      incomplete.abort("inspection only");
    } finally {
      await runtimeB?.dispose();
      await runtimeA.dispose();
      await smB?.close();
      await smA.close();
      await server.close();
    }
  });
});
