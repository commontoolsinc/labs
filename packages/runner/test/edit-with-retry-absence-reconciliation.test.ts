import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
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
    } finally {
      provider.loadUnexaminedAbsences = original;
      await runtime.dispose();
      await sm.close();
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
      // Of the two cold reads, exactly one document turns out to exist; the
      // other's absence is examined and stays a sound claim.
      expect(await provider.loadUnexaminedAbsences!(txB.tx)).toBe(1);
      // Loaded is loaded: a second pass finds nothing left unexamined.
      expect(await provider.loadUnexaminedAbsences!(txB.tx)).toBe(0);
      txB.abort("inspection only");
    } finally {
      await runtimeB?.dispose();
      await runtimeA.dispose();
      await smB?.close();
      await smA.close();
      await server.close();
    }
  });
});
