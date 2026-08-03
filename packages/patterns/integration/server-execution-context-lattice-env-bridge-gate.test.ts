/**
 * C1.7 env-bridge gate: the `context-lattice-claims-v1` subcapability
 * negotiates END TO END from the ENV DIALS ALONE — no injected
 * `protocolFlags`, no harness-local `MULTI_RUNTIME_CONTEXT_LATTICE_CLAIMS`
 * escape hatch, on both halves of the handshake.
 *
 * WHY: this is the F5 miswire again, one subcapability over. The CA4 audit
 * (client-passivity §5g item 5) names it as the BINDING blocker for the
 * user-rank measurement: the subcapability's dial is programmatic-only on
 * BOTH sides, so
 *
 *   - no deployment can make a server advertise it
 *     (`applyServerPrimaryExecutionEnvConfig` applied only the base dial and
 *     the doc-set-watch dial), and
 *   - no browser-shaped client can offer it in its `hello`
 *     (`ExperimentalOptions` had no key for it, so `experimentalOptionsFromEnv`
 *     could not carry it and the `Runtime` constructor never installed it as
 *     the client realm's ambient memory config).
 *
 * Because the amendment-11 cohort gate requires EVERY session of a principal
 * — TTL-detached ones included — to have negotiated before `openUserLaneGrant`
 * may open a lane (`packages/memory/v2/server.ts` `openUserLaneGrant`), a
 * fleet whose clients cannot negotiate has un-openable user lanes, and every
 * server-side rank dial under it is inert. The F5 gate
 * (`server-execution-f5-env-bridge-gate.test.ts`) is the precedent AND the
 * warning: the identical "dial never reached the advertisement in a
 * realm-separated deployment" defect already shipped once.
 *
 * This gate drives the REAL composed topology the way production wires it:
 *
 *   - server: `StandaloneMemoryServer.start()` in the test realm — the real
 *     production construction (no injected flags), advertisement derived from
 *     `EXPERIMENTAL_SERVER_PRIMARY_EXECUTION[_CONTEXT_LATTICE_CLAIMS]` at
 *     construction;
 *   - clients: full production stacks (PiecesController over a real
 *     WebSocket) in their own Deno Worker realms, whose Runtime constructor
 *     derives the SAME env through `experimentalOptionsFromEnv` — the exact
 *     mechanism the browser worker uses with build-time defines.
 *
 * Assertions: the wire handshake advertises the subcap (hello.ok), AND the
 * server records the worker-realm client's session as negotiating it — the
 * per-session flag the cohort gate reduces over. The cohort gauge reports
 * `sessions` alongside `negotiating` because the gate's own predicate is an
 * `every()` and is vacuously true for an empty cohort.
 *
 * Discrimination: with the subcapability dial UNSET (base dial still on), the
 * advertisement drops to false and the same live session negotiates nothing —
 * proving the bridge is wired to the dial, not unconditionally on.
 */

import { assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
  resetServerPrimaryExecutionConfig,
  resetServerPrimaryExecutionContextLatticeClaimsConfig,
  type WireMemoryProtocolFlags,
  wireMemoryProtocolFlags,
} from "@commonfabric/memory/v2";
import { MultiRuntimeHarness } from "./multi-runtime-harness.ts";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "fixtures",
  "server-primary-rollout.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

const BASE_ENV = "EXPERIMENTAL_SERVER_PRIMARY_EXECUTION";
const CONTEXT_LATTICE_CLAIMS_ENV =
  "EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_CONTEXT_LATTICE_CLAIMS";
/** The harness-local escape hatch this gate retired (`multi-runtime-worker.ts`
 * no longer reads it). Still force-unset for the whole file, so a stale
 * ambient value in a developer's shell can never manufacture a pass. */
const HARNESS_LOCAL_ENV = "MULTI_RUNTIME_CONTEXT_LATTICE_CLAIMS";

/**
 * FW7 teardown barrier (local copy, matching
 * `server-execution-user-lane-gate.test.ts`): a pending no-op timer keeps the
 * Deno event loop refed across worker termination so `--trace-leaks`
 * sanitizers stay green.
 */
const withExecutorTeardownBarrier = async <T>(
  fn: () => Promise<T>,
): Promise<T> => {
  const keepAlive = setInterval(() => {}, 60_000);
  try {
    return await fn();
  } finally {
    clearInterval(keepAlive);
  }
};

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
    // The standalone server's env appliers mutate THIS realm's ambient dials;
    // leave the realm as we found it for later test files.
    resetServerPrimaryExecutionConfig();
    resetServerPrimaryExecutionContextLatticeClaimsConfig();
  }
}

/** Complete a real WebSocket `hello` against the harness's self-hosted
 * server and return the flags it advertised. */
async function advertisedFlags(
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
        const message = JSON.parse(
          (event.data as string).replace(/^fvj1:/, ""),
        ) as { type?: string; flags?: WireMemoryProtocolFlags };
        if (message.type === "hello.ok" && message.flags !== undefined) {
          resolve(message.flags);
        } else {
          reject(new Error(`expected hello.ok, got ${event.data}`));
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

Deno.test("C1.7 env bridge: context-lattice-claims-v1 negotiates from the env dials alone (no injected flags)", async (t) => {
  await t.step(
    "dials on: subcap advertised on the wire and a worker-realm client negotiates it",
    async () => {
      await withExecutorTeardownBarrier(() =>
        withEnv({
          [BASE_ENV]: "true",
          [CONTEXT_LATTICE_CLAIMS_ENV]: "true",
          [HARNESS_LOCAL_ENV]: undefined,
        }, async () => {
          const harness = await MultiRuntimeHarness.create({
            programPath: PROGRAM_PATH,
            rootPath: ROOT_PATH,
            sessions: ["alice"],
          });
          try {
            const server = harness.memoryServer;
            assertExists(server, "harness must self-host the storage server");
            const flags = await advertisedFlags(server.url);
            assertEquals(flags.serverPrimaryExecutionV1, true);
            assertEquals(
              flags.serverPrimaryExecutionContextLatticeClaimsV1,
              true,
            );
            // Negotiation, not just advertisement: the worker-realm client's
            // OWN hello must carry the subcap, and the server records that on
            // the session the cohort gate reads.
            const alice = harness.session("alice");
            const { space } = await alice.link([]);
            const principal = alice.identity.did();
            await harness.waitFor(
              "the client's session negotiated context-lattice-claims-v1",
              () => {
                const cohort = server.contextLatticeClaimsCohort(
                  space,
                  principal,
                );
                return cohort.sessions > 0 &&
                  cohort.negotiating === cohort.sessions;
              },
            );
          } finally {
            await harness.dispose();
          }
        })
      );
    },
  );

  await t.step(
    "discrimination — subcap dial off: not advertised, and the same live session negotiates nothing",
    async () => {
      await withExecutorTeardownBarrier(() =>
        withEnv({
          [BASE_ENV]: "true",
          [CONTEXT_LATTICE_CLAIMS_ENV]: undefined,
          [HARNESS_LOCAL_ENV]: undefined,
        }, async () => {
          const harness = await MultiRuntimeHarness.create({
            programPath: PROGRAM_PATH,
            rootPath: ROOT_PATH,
            sessions: ["alice"],
          });
          try {
            const server = harness.memoryServer;
            assertExists(server, "harness must self-host the storage server");
            const flags = await advertisedFlags(server.url);
            assertEquals(flags.serverPrimaryExecutionV1, true);
            assertEquals(
              flags.serverPrimaryExecutionContextLatticeClaimsV1,
              false,
            );
            const alice = harness.session("alice");
            const { space } = await alice.link([]);
            const principal = alice.identity.did();
            await harness.settle(3);
            const cohort = server.contextLatticeClaimsCohort(space, principal);
            assertEquals(
              cohort.sessions > 0,
              true,
              "the client must have a live session — otherwise the cohort " +
                "gate's every() is vacuously true and this arm proves nothing",
            );
            assertEquals(
              cohort.negotiating,
              0,
              "no session may negotiate the subcap without the dial",
            );
          } finally {
            await harness.dispose();
          }
        })
      );
    },
  );
});
