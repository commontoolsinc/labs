import { assertEquals, assertExists } from "@std/assert";
import { toFileUrl } from "@std/path";
import * as Engine from "../v2/engine.ts";

const SPACE = "did:key:z6Mk-legacy-background-exclusion-space";
const PRINCIPAL = "did:key:z6Mk-legacy-background-service";

const openTempEngine = async (): Promise<{
  directory: string;
  engine: Engine.Engine;
}> => {
  const directory = await Deno.makeTempDir();
  return {
    directory,
    engine: await Engine.open({
      url: toFileUrl(`${directory}/space.sqlite`),
    }),
  };
};

const acquireClient = (
  engine: Engine.Engine,
  nowMs: number,
  hostId = "host:client",
) =>
  Engine.acquireExecutionLease(engine, {
    space: SPACE,
    branch: "",
    hostId,
    onBehalfOf: "did:key:z6Mk-client-user",
    nowMs,
    ttlMs: 1_000,
    authorizeWrite: () => true,
  });

const acquireBackground = (
  engine: Engine.Engine,
  nowMs: number,
  holderId = "background:one",
) =>
  Engine.acquireLegacyBackgroundExclusion(engine, {
    space: SPACE,
    branch: "",
    holderId,
    servicePrincipal: PRINCIPAL,
    nowMs,
    ttlMs: 1_000,
    drainTtlMs: 100,
    authorizeService: () => true,
  });

Deno.test("live background exclusion blocks client lease acquisition", async () => {
  const { directory, engine } = await openTempEngine();
  try {
    const acquired = acquireBackground(engine, 100);
    assertExists(acquired);
    assertEquals(acquired.serverTime, 100);
    assertEquals(acquired.ready, true);
    assertEquals(acquired.blockedUntil, undefined);
    assertEquals(acquired.exclusion.exclusionGeneration, 1);
    assertEquals(acquired.exclusion.holderId, "background:one");
    assertEquals(acquired.exclusion.servicePrincipal, PRINCIPAL);
    assertEquals(acquireClient(engine, 101), null);

    // Expiry is fail-safe: clients can acquire without an explicit release.
    const afterExpiry = acquireClient(engine, 1_101);
    assertExists(afterExpiry);
    assertEquals(afterExpiry.leaseGeneration, 1);
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("background acquisition atomically drains the client lease", async () => {
  const { directory, engine } = await openTempEngine();
  try {
    const client = acquireClient(engine, 100);
    assertExists(client);
    assertEquals(client.expiresAt, 1_100);

    const acquired = acquireBackground(engine, 200);
    assertExists(acquired);
    assertEquals(acquired.ready, false);
    // A different host may still be enforcing the lease snapshot it acquired.
    // Background readiness therefore waits for that advertised deadline rather
    // than the shorter host-local drain grace.
    assertEquals(acquired.blockedUntil, 1_100);
    assertEquals(
      Engine.currentExecutionLease(engine, {
        space: SPACE,
        branch: "",
        nowMs: 201,
      }),
      { ...client, state: "draining" },
    );
    assertEquals(
      Engine.renewExecutionLease(engine, {
        lease: client,
        nowMs: 201,
        ttlMs: 1_000,
        authorizeWrite: () => true,
      }),
      null,
    );

    const blocked = Engine.renewLegacyBackgroundExclusion(engine, {
      exclusion: acquired.exclusion,
      nowMs: 250,
      ttlMs: 1_000,
      drainTtlMs: 100,
      authorizeService: () => true,
    });
    assertExists(blocked);
    assertEquals(blocked.serverTime, 250);
    assertEquals(blocked.ready, false);
    assertEquals(blocked.blockedUntil, 1_100);

    const ready = Engine.renewLegacyBackgroundExclusion(engine, {
      exclusion: blocked.exclusion,
      nowMs: 1_101,
      ttlMs: 1_000,
      drainTtlMs: 100,
      authorizeService: () => true,
    });
    assertExists(ready);
    assertEquals(ready.serverTime, 1_101);
    assertEquals(ready.ready, true);
    assertEquals(ready.blockedUntil, undefined);
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("background exclusion uses exact monotonic generation fencing", async () => {
  const { directory, engine } = await openTempEngine();
  try {
    const first = acquireBackground(engine, 100, "background:first");
    assertExists(first);
    assertEquals(acquireBackground(engine, 101, "background:second"), null);

    const released = Engine.releaseLegacyBackgroundExclusion(engine, {
      exclusion: first.exclusion,
      nowMs: 102,
      authorizeService: () => true,
    });
    assertExists(released);
    assertEquals(released.expiresAt, 102);

    const second = acquireBackground(engine, 103, "background:second");
    assertExists(second);
    assertEquals(second.exclusion.exclusionGeneration, 2);
    assertEquals(
      Engine.releaseLegacyBackgroundExclusion(engine, {
        exclusion: first.exclusion,
        nowMs: 104,
        authorizeService: () => true,
      }),
      null,
    );
    assertEquals(
      Engine.currentLegacyBackgroundExclusion(engine, {
        space: SPACE,
        branch: "",
        nowMs: 104,
      }),
      second.exclusion,
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});
