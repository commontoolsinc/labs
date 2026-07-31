import { assert, assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import type { Runtime } from "@commonfabric/runner";
import { BackgroundPieceService } from "../src/service.ts";

/**
 * The bg service is DISABLED under server-primary execution (owner ruling,
 * 2026-07-31): it is "a runtime that runs pieces on the server by pretending to
 * be a client", which is what server-primary execution abolishes, so it is
 * sunset rather than migrated. `bgUpdater` returns later in a simpler form.
 *
 * Both arms share ONE fixture whose storage manager THROWS on first touch, and
 * they differ only in the flag. That is what makes this a measurement rather
 * than a tautology: the flag-off arm must reach storage and throw, proving the
 * fixture is live and the flag-on arm's silence is caused by the bail and not
 * by an inert stub.
 *
 * The bail's position is load-bearing beyond "does no work". `ensurePieces`
 * acquires a `LegacyBackgroundExclusion` in exactly the flag-on case, and while
 * one is live the memory engine refuses to acquire OR renew an execution lease
 * for that space and the pool parks the slot `state: "excluded"` — i.e. this
 * service structurally locks the space executor OUT of every space with a live
 * bg registration. Returning before any exclusion is taken is what lets the
 * executor into those spaces at all.
 */

const STORAGE_TOUCHED = "storage-was-touched";

function runtimeStub(serverPrimaryExecution: boolean): Runtime {
  const explode = (): never => {
    throw new Error(STORAGE_TOUCHED);
  };
  return {
    experimental: { serverPrimaryExecution },
    // Any read of this manager is a storage touch. `getBGPieces` reaches it
    // through `getCell`/`open`, and `initialize` awaits `synced()`.
    storageManager: new Proxy({}, { get: explode }),
    getCell: explode,
    storage: new Proxy({}, { get: explode }),
  } as unknown as Runtime;
}

function serviceFor(serverPrimaryExecution: boolean) {
  const created: unknown[] = [];
  const service = new BackgroundPieceService({
    identity: {} as never,
    toolshedUrl: "https://toolshed.invalid",
    runtime: runtimeStub(serverPrimaryExecution),
    createSpaceManager: (options) => {
      created.push(options);
      return {
        start: () => {},
        stop: () => Promise.resolve(),
        watch: () => () => {},
      };
    },
  });
  return { service, created };
}

describe("background piece service under server-primary execution", () => {
  it("does not run, and takes no legacy-background exclusion", async () => {
    const { service, created } = serviceFor(true);

    // Must not throw: the bail returns before any storage touch.
    await service.initialize();

    assertEquals(
      created.length,
      0,
      "a SpaceManager was created, so an exclusion could be acquired and the " +
        "space executor would be locked out",
    );

    // `isRunning` stays false, so `stop()` is a clean no-op rather than a
    // teardown of things that were never built.
    assertEquals(await service.stop(), []);
  });

  it("CONTROL: with the flag off it still reaches storage (fixture is live)", async () => {
    const { service } = serviceFor(false);

    let thrown: unknown;
    try {
      await service.initialize();
    } catch (error) {
      thrown = error;
    }

    assert(
      thrown instanceof Error && thrown.message === STORAGE_TOUCHED,
      `expected the flag-off arm to touch storage; got ${thrown}`,
    );
  });
});
