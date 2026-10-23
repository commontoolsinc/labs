/**
 * A handler's read-then-write against a commit its replica had not seen yet.
 *
 * A peer's commit lands in the store, and the handler's replica has not heard
 * of it when the handler reads. The handler's write is computed from the old
 * value, so it must not land over the peer's: with server execution off, the
 * read travels with the commit and Memory refuses it as stale. On a serving
 * runtime the handler seals into a wave, which drops the read and checks each
 * written document's head against the store's seq when the wave opened. A
 * seal opens the wave, so the peer's commit sits at or below that seq and the
 * check passes. Both cases here hold the handler to the same outcome.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import * as Engine from "@commonfabric/memory/v2/engine";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { Cell } from "../src/cell.ts";
import { stampWaveRunContext } from "../src/executor/wave.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { ServingWaves } from "./support/serving-waves.ts";

const signer = await Identity.fromPassphrase("serving handler stale read");
const space = signer.did() as MemorySpace;

const counterSchema = {
  type: "number",
  // deno-lint-ignore no-explicit-any
} as any;

/**
 * Commits `value` as `cell`'s whole value straight to `engine` from another
 * session, so no replica hears of it, and returns the commit's seq.
 */
const commitUnseen = (
  engine: Engine.Engine,
  cell: Cell<number>,
  value: number,
): number =>
  Engine.applyCommit(engine, {
    sessionId: "session:peer",
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: cell.getAsNormalizedFullLink().id,
        value: { value },
      }],
    },
  }).seq;

/** The counter's value as `engine` holds it. */
const stored = (engine: Engine.Engine, cell: Cell<number>): unknown =>
  Engine.read(engine, { id: cell.getAsNormalizedFullLink().id });

describe("serving-handler-stale-read", () => {
  describe("with server execution off", () => {
    let server: MemoryV2Server.Server;
    let storage: EmulatedStorageManager;
    let runtime: Runtime;

    beforeEach(() => {
      server = newSharedServer();
      storage = EmulatedStorageManager.connectTo(server, { as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
      });
    });
    afterEach(async () => {
      await runtime?.dispose();
      await storage?.close();
      await server?.close();
    });

    it("refuses a handler's write computed from a value the store has replaced", async () => {
      const seed = runtime.edit();
      const counter = runtime.getCell<number>(
        space,
        "counter",
        counterSchema,
        seed,
      );
      counter.set(0);
      expect((await seed.commit().settled).error).toBeUndefined();
      await storage.synced();
      const engine = await server.engineForSpace(space);

      commitUnseen(engine, counter, 5);
      const tx = runtime.edit();
      const handled = counter.withTx(tx);
      expect(handled.get(), "the replica has not seen the peer").toBe(0);
      handled.set(handled.get() + 1);
      const { error } = await tx.commit().settled;

      expect(error?.name).toBe("ConflictError");
      expect(stored(engine, counter)).toEqual({ value: 5 });
    });
  });

  describe("with server execution on", () => {
    let waves: ServingWaves;

    beforeEach(async () => {
      waves = await ServingWaves.open(signer);
    });
    afterEach(async () => {
      await waves.dispose();
    });

    it("keeps a commit that lands after the wave opened from being overwritten", async () => {
      const { runtime, engine } = waves;
      const counter = runtime.getCell<number>(space, "counter", counterSchema);
      const seed = runtime.edit();
      counter.withTx(seed).set(0);
      expect((await seed.commit().settled).error).toBeUndefined();
      await waves.storageManager.synced();
      waves.serve();

      waves.openWave();
      commitUnseen(engine, counter, 5);
      const tx = runtime.edit();
      stampWaveRunContext(tx, { actionId: "increment", kind: "event-handler" });
      const handled = counter.withTx(tx);
      handled.set(handled.get() + 1);
      await tx.commit().settled;
      await waves.commitWave();

      expect(stored(engine, counter)).toEqual({ value: 5 });
    });

    it("keeps a commit the handler's replica never saw from being overwritten", async () => {
      const { runtime, engine } = waves;
      const counter = runtime.getCell<number>(space, "counter", counterSchema);
      const seed = runtime.edit();
      counter.withTx(seed).set(0);
      expect((await seed.commit().settled).error).toBeUndefined();
      await waves.storageManager.synced();
      waves.serve();

      commitUnseen(engine, counter, 5);
      const tx = runtime.edit();
      stampWaveRunContext(tx, { actionId: "increment", kind: "event-handler" });
      const handled = counter.withTx(tx);
      expect(handled.get(), "the replica has not seen the peer").toBe(0);
      handled.set(handled.get() + 1);
      await tx.commit().settled;
      await waves.commitWave();

      expect(stored(engine, counter)).toEqual({ value: 5 });
    });
  });
});
