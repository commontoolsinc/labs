// Server-primary ADVERTISEMENT bridge (feed FW6): env dials must reach the
// flags a production-constructed memory server advertises on the wire.
//
// WHY: the 2026-07-24 integration run pinned that F5 could not engage from a
// real client because the two production server constructions (toolshed
// routes/storage/memory.ts and this standalone server) advertise
// `getMemoryProtocolFlags()`, whose server-primary ambient dials were only
// installed as a SIDE EFFECT of constructing a Runtime in the same realm.
// Hosts that never construct a Runtime in the server realm — the standalone
// server in the multi-runtime harness, `cf test` multi-user mode — advertised
// every server-primary capability false regardless of the env, so a
// dial-driven client negotiated nothing. These tests drive the REAL
// construction path (`StandaloneMemoryServer.start()`, no injected
// `protocolFlags` — deliberately NOT the scripted-peer shape the integration
// gates use) and the REAL wire handshake (a WebSocket `hello`), against the
// canonical env names.
//
// Discrimination legs: the dial-off runs prove the advertisement is WIRED TO
// the env dials rather than unconditionally on, and pin the full default flag
// set byte-for-byte. Since 2026-08-01 those legs must set the env explicitly
// to `"false"`: the server-primary dial set defaults ON, so "unset" is no
// longer the off direction and a discrimination leg that relies on omission
// proves nothing.

import { assert, assertEquals, assertExists } from "@std/assert";
import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
  resetServerPrimaryExecutionConfig,
  resetServerPrimaryExecutionContextLatticeClaimsConfig,
  resetServerPrimaryExecutionDocSetWatchConfig,
  resetServerPrimaryExecutionGraphRetirementConfig,
  setServerPrimaryExecutionConfig,
  setServerPrimaryExecutionContextLatticeClaimsConfig,
  type WireMemoryProtocolFlags,
  wireMemoryProtocolFlags,
} from "../v2.ts";
import { StandaloneMemoryServer } from "../v2/standalone.ts";

const BASE_ENV = "EXPERIMENTAL_SERVER_PRIMARY_EXECUTION";
const DOC_SET_WATCH_ENV = "EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_DOC_SET_WATCH";
const CONTEXT_LATTICE_CLAIMS_ENV =
  "EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_CONTEXT_LATTICE_CLAIMS";

/** The complete default advertisement (every dial at its built-in default).
 * A committed golden: the safety property of the env bridge is that with the
 * dials unset the advertised flags are BYTE-IDENTICAL to this. */
const DEFAULT_ADVERTISED_FLAGS = {
  modernCellRep: false,
  persistentSchedulerState: true,
  // The server-primary dial SET defaults on together (2026-08-01); the
  // doc-set watch feed is deliberately not part of that set.
  serverPrimaryExecutionV1: true,
  serverPrimaryExecutionClaimRoutingV1: true,
  serverPrimaryExecutionBuiltinPassivityV1: true,
  serverPrimaryExecutionContextLatticeClaimsV1: true,
  serverPrimaryExecutionCrossSpaceClaimsV1: true,
  serverPrimaryExecutionDocSetWatchV1: false,
  schedulerWriterLookup: true,
  commitPreconditions: true,
  syncSchemaTable: false,
  sqliteCommitRowLabelEval: true,
  syncSchemaTableV2: true,
  pendingReadStacks: true,
  entityIdListing: true,
  entityIdPagination: true,
  entityIdLookup: true,
};

/** Run `fn` with the named env vars set (undefined = force-unset), restoring
 * the prior process values and resetting the ambient dials afterwards. */
async function withEnv<T>(
  values: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const original = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    original.set(name, Deno.env.get(name));
    if (value === undefined) Deno.env.delete(name);
    else Deno.env.set(name, value);
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of original.entries()) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
    resetServerPrimaryExecutionConfig();
    resetServerPrimaryExecutionDocSetWatchConfig();
    resetServerPrimaryExecutionContextLatticeClaimsConfig();
    resetServerPrimaryExecutionGraphRetirementConfig();
  }
}

/** Complete a REAL WebSocket `hello` handshake against `serverUrl` and return
 * the flags the server advertised in `hello.ok`. */
async function advertisedFlagsOverWebSocket(
  serverUrl: URL,
): Promise<WireMemoryProtocolFlags> {
  const wsUrl = new URL(serverUrl.href);
  wsUrl.protocol = "ws:";
  const socket = new WebSocket(wsUrl.href);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error("websocket connect failed")),
        { once: true },
      );
    });
    const reply = new Promise<WireMemoryProtocolFlags>((resolve, reject) => {
      socket.addEventListener("message", (event) => {
        const message = decodeMemoryBoundary(event.data as string) as {
          type?: string;
          flags?: WireMemoryProtocolFlags;
          error?: { message?: string };
        };
        if (message.type === "hello.ok") {
          assertExists(message.flags, "hello.ok must carry advertised flags");
          resolve(message.flags);
        } else {
          reject(
            new Error(
              `expected hello.ok, got: ${JSON.stringify(message)}`,
            ),
          );
        }
      }, { once: true });
    });
    socket.send(encodeMemoryBoundary({
      type: "hello",
      protocol: MEMORY_PROTOCOL,
      flags: wireMemoryProtocolFlags(getMemoryProtocolFlags()),
    }));
    return await reply;
  } finally {
    socket.close();
  }
}

Deno.test("FW6: a production-constructed standalone server advertises the server-primary caps from the env dials", async () => {
  await withEnv({
    [BASE_ENV]: "true",
    [DOC_SET_WATCH_ENV]: "true",
    [CONTEXT_LATTICE_CLAIMS_ENV]: "false",
  }, async () => {
    const server = StandaloneMemoryServer.start();
    try {
      const flags = await advertisedFlagsOverWebSocket(server.url);
      assertEquals(flags.serverPrimaryExecutionV1, true);
      assertEquals(flags.serverPrimaryExecutionClaimRoutingV1, true);
      assertEquals(flags.serverPrimaryExecutionBuiltinPassivityV1, true);
      assertEquals(flags.serverPrimaryExecutionDocSetWatchV1, true);
      // Each canonical dial is wired independently and no dial implies
      // another — pinned in the direction that still discriminates now that
      // the set defaults on: an explicit `false` on the context-lattice dial
      // withholds it while its siblings stay advertised.
      assertEquals(flags.serverPrimaryExecutionContextLatticeClaimsV1, false);
      // No env dial of its own; rides the dial-set default.
      assertEquals(flags.serverPrimaryExecutionCrossSpaceClaimsV1, true);
    } finally {
      await server.close();
    }
  });
});

// C1.7's half of the same bridge (client-passivity §5g item 5, the CA4
// audit): before this, `serverPrimaryExecutionContextLatticeClaimsV1` had no
// env mapping at all, so no deployment could advertise it — and the
// amendment-11 cohort gate made user lanes un-openable as a result.
Deno.test("C1.7: the context-lattice-claims subcap advertises from its own env dial", async () => {
  await withEnv({
    [BASE_ENV]: "true",
    [CONTEXT_LATTICE_CLAIMS_ENV]: "true",
    [DOC_SET_WATCH_ENV]: undefined,
  }, async () => {
    const server = StandaloneMemoryServer.start();
    try {
      const flags = await advertisedFlagsOverWebSocket(server.url);
      assertEquals(flags.serverPrimaryExecutionV1, true);
      assertEquals(flags.serverPrimaryExecutionContextLatticeClaimsV1, true);
      // Independent of the sibling subcapability dials, both directions: the
      // doc-set feed is not in the dial set (default off), cross-space claims
      // are (default on).
      assertEquals(flags.serverPrimaryExecutionDocSetWatchV1, false);
      assertEquals(flags.serverPrimaryExecutionCrossSpaceClaimsV1, true);
    } finally {
      await server.close();
    }
  });
});

// Was "base dial alone never advertises it", which stopped being a
// proposition when the subcap joined the default-on dial set. What still
// needs pinning — and is the same wiring property — is the OTHER direction:
// an explicit `false` withholds the subcap while the base capability stays
// advertised, so the two are not one flag wearing two names.
Deno.test("C1.7: the context-lattice-claims subcap is separately wired — an explicit false withholds it", async () => {
  await withEnv({
    [BASE_ENV]: "true",
    [CONTEXT_LATTICE_CLAIMS_ENV]: "false",
  }, async () => {
    const server = StandaloneMemoryServer.start();
    try {
      const flags = await advertisedFlagsOverWebSocket(server.url);
      assertEquals(flags.serverPrimaryExecutionV1, true);
      assertEquals(flags.serverPrimaryExecutionContextLatticeClaimsV1, false);
    } finally {
      await server.close();
    }
  });
});

// The subcapability is layered ABOVE the base capability: its own dial on,
// the base dial off ⇒ still not advertised (getMemoryProtocolFlags folds the
// two). Without this leg a deployment could believe the subcap was live from
// one env var.
Deno.test("C1.7: the context-lattice-claims dial alone never advertises without the base dial", async () => {
  await withEnv({
    [BASE_ENV]: "false",
    [CONTEXT_LATTICE_CLAIMS_ENV]: "true",
  }, async () => {
    const server = StandaloneMemoryServer.start();
    try {
      const flags = await advertisedFlagsOverWebSocket(server.url);
      assertEquals(flags.serverPrimaryExecutionV1, false);
      assertEquals(flags.serverPrimaryExecutionContextLatticeClaimsV1, false);
    } finally {
      await server.close();
    }
  });
});

Deno.test("FW6: the doc-set-watch subcap stays layered — base dial alone never advertises it", async () => {
  await withEnv({
    [BASE_ENV]: "true",
    [DOC_SET_WATCH_ENV]: undefined,
  }, async () => {
    const server = StandaloneMemoryServer.start();
    try {
      const flags = await advertisedFlagsOverWebSocket(server.url);
      assertEquals(flags.serverPrimaryExecutionV1, true);
      assertEquals(flags.serverPrimaryExecutionDocSetWatchV1, false);
    } finally {
      await server.close();
    }
  });
});

Deno.test("FW6 discrimination: dials unset ⇒ the advertisement is byte-identical to the all-default flags", async () => {
  await withEnv({
    [BASE_ENV]: undefined,
    [DOC_SET_WATCH_ENV]: undefined,
    [CONTEXT_LATTICE_CLAIMS_ENV]: undefined,
  }, async () => {
    // Fresh dial state, then the REAL construction with nothing set.
    resetServerPrimaryExecutionConfig();
    resetServerPrimaryExecutionDocSetWatchConfig();
    resetServerPrimaryExecutionContextLatticeClaimsConfig();
    const server = StandaloneMemoryServer.start();
    try {
      const flags = await advertisedFlagsOverWebSocket(server.url);
      assertEquals(flags, DEFAULT_ADVERTISED_FLAGS);
      assertEquals(
        wireMemoryProtocolFlags(getMemoryProtocolFlags()),
        DEFAULT_ADVERTISED_FLAGS,
      );
    } finally {
      await server.close();
    }
  });
});

Deno.test("FW6: non-canonical env values are ignored (with a warning), never coerced", async () => {
  await withEnv({
    [BASE_ENV]: "1",
    [DOC_SET_WATCH_ENV]: "yes",
    [CONTEXT_LATTICE_CLAIMS_ENV]: "on",
  }, async () => {
    // Pre-set the two default-ON dials to `false`, so "ignored" and "coerced
    // to true" have DIFFERENT observable outcomes. Without this the garbage
    // values would land on the same advertisement the default produces and
    // the test would pass whether or not the parser coerced.
    setServerPrimaryExecutionConfig(false);
    setServerPrimaryExecutionContextLatticeClaimsConfig(false);
    const server = StandaloneMemoryServer.start();
    try {
      const flags = await advertisedFlagsOverWebSocket(server.url);
      assert(flags.serverPrimaryExecutionV1 === false);
      assert(flags.serverPrimaryExecutionDocSetWatchV1 === false);
      assert(flags.serverPrimaryExecutionContextLatticeClaimsV1 === false);
    } finally {
      await server.close();
    }
  });
});
