/**
 * F5 env-bridge gate: the doc-set-watch subcapability negotiates END TO END
 * from the ENV DIALS ALONE — no injected protocol flags anywhere.
 *
 * WHY: the three server-primary integration gates construct their servers
 * with explicit `protocolFlags` (the scripted-peer shape), so they cannot
 * catch the production miswire the 2026-07-24 integration run pinned: real
 * server constructions advertise `getMemoryProtocolFlags()`, whose
 * server-primary dials were only ever installed as a side effect of
 * constructing a Runtime in the server's realm. In every realm-separated
 * deployment shape (browser ↔ toolshed, multi-runtime harness ↔ standalone
 * server) no Runtime exists in the server realm, so the env dials never
 * reached the advertisement and clients negotiated nothing.
 *
 * This gate drives the REAL composed topology the way production wires it:
 *
 *   - server: `StandaloneMemoryServer.start()` in the test realm — the real
 *     production construction (no injected flags), advertisement derived
 *     from `EXPERIMENTAL_SERVER_PRIMARY_EXECUTION[_DOC_SET_WATCH]` at
 *     construction, doc-set admission from
 *     `EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_GRAPH_RETIREMENT_SPACES`;
 *   - clients: full production stacks (PiecesController over a real
 *     WebSocket) in their own Deno Worker realms, whose Runtime constructor
 *     derives the SAME env through `experimentalOptionsFromEnv` — the exact
 *     mechanism the browser worker uses with build-time defines.
 *
 * Assertions: the wire handshake advertises the subcap (hello.ok), and the
 * client actually ENGAGES it — the server's doc-set membership gauge goes
 * positive (F4b closure export, `feedStats.docSetMembersTracked`).
 *
 * Discrimination: with the doc-set dial UNSET (base dial still on), the
 * advertisement drops to false and no membership is ever tracked — proving
 * the bridge is wired to the dial, not unconditionally on.
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
  resetServerPrimaryExecutionConfig,
  resetServerPrimaryExecutionDocSetWatchConfig,
  resetServerPrimaryExecutionGraphRetirementConfig,
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
const DOC_SET_WATCH_ENV = "EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_DOC_SET_WATCH";
const RETIREMENT_SPACES_ENV =
  "EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_GRAPH_RETIREMENT_SPACES";

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
    // The standalone server's env appliers mutate THIS realm's ambient
    // dials; leave the realm as we found it for later test files.
    resetServerPrimaryExecutionConfig();
    resetServerPrimaryExecutionDocSetWatchConfig();
    resetServerPrimaryExecutionGraphRetirementConfig();
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

Deno.test("F5 env bridge: doc-set watch negotiates and engages from the env dials alone (no injected flags)", async (t) => {
  await t.step(
    "dials on: subcap advertised on the wire and doc-set membership engages",
    async () => {
      await withEnv({
        [BASE_ENV]: "true",
        [DOC_SET_WATCH_ENV]: "true",
        [RETIREMENT_SPACES_ENV]: "*",
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
          assertEquals(flags.serverPrimaryExecutionDocSetWatchV1, true);
          // Engagement, not just negotiation: the worker-realm client
          // exports its held-doc closure as a `docs` watch, so the server's
          // membership gauge (updated at registration) goes positive.
          await harness.waitFor(
            "doc-set membership tracked by the server",
            () => server.feedStats.docSetMembersTracked > 0,
          );
        } finally {
          await harness.dispose();
        }
      });
    },
  );

  await t.step(
    "discrimination — doc-set dial off: subcap not advertised, no membership ever tracked",
    async () => {
      await withEnv({
        [BASE_ENV]: "true",
        [DOC_SET_WATCH_ENV]: undefined,
        [RETIREMENT_SPACES_ENV]: "*",
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
          assertEquals(flags.serverPrimaryExecutionDocSetWatchV1, false);
          await harness.settle(3);
          assert(
            server.feedStats.docSetMembersTracked === 0,
            "no docs watch may register without the negotiated subcap",
          );
        } finally {
          await harness.dispose();
        }
      });
    },
  );
});
