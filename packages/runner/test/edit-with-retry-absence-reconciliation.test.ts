import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
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
