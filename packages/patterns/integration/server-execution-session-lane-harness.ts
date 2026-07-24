/**
 * C2.10 shared loopback harness for the session-lane gates.
 *
 * Why: C2.10 adds two more default-run gates that self-host the full
 * production loop the way the landed C2.9 gate does — a real memory-v2
 * Server (file-backed SQLite store), the real SharedExecutionPool with a
 * REAL Deno executor Worker, and one real client Runtime per session over
 * the loopback transport (the session dials are deliberately
 * programmatic-only, so only in-process fixtures can flip them). Rather
 * than copying C2.9's ~200 lines of scaffolding into each new gate, the
 * scaffolding lives here once.
 *
 * The landed C2.9 gate (server-execution-session-lane-gate.test.ts) keeps
 * its own file-local copy on purpose: it is a landed, mutation-verified
 * gate and C2.10 does not touch it. Folding it onto this module is a
 * follow-on refactor for whoever next has to edit that file anyway.
 *
 * Everything here is measurement scaffolding, not assertion logic: the
 * gates own their assertions.
 */

import { assertExists } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import {
  type ClientCommit,
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  type MemoryProtocolFlags,
  sessionExecutionContextKey,
  userExecutionContextKey,
} from "@commonfabric/memory/v2";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import type { Server } from "@commonfabric/memory/v2/server";
import { Runtime } from "@commonfabric/runner";
import {
  type Options as StorageOptions,
  type SessionFactory,
  StorageManager,
} from "@commonfabric/runner/storage/cache.deno";

/** The C2 gate protocol flags: server-primary execution with the
 * context-lattice claims subcapability every gate session negotiates, so
 * session lanes may open (C2.3's own-session admission). */
export const SESSION_LANE_GATE_FLAGS = {
  persistentSchedulerState: true,
  schedulerWriterLookup: true,
  serverPrimaryExecutionV1: true,
  serverPrimaryExecutionClaimRoutingV1: true,
  serverPrimaryExecutionBuiltinPassivityV1: true,
  serverPrimaryExecutionContextLatticeClaimsV1: true,
} as const satisfies Partial<MemoryProtocolFlags>;

/** Loopback client sessions against the in-process server, authenticated as
 * the storage signer's principal. `supportsExecutionDemand` opts the runner
 * into publishing connection-owned root demand from each client session, so
 * the pool derives per-SESSION lane demand exactly as deployed (C2.7). The
 * factory records the mounted session's id (gates need each client's
 * canonical `session:<did>:<sid>` lane key) and can tap every client→server
 * commit and server→client message. */
export class LoopbackSessionFactory implements SessionFactory {
  readonly supportsExecutionDemand = true;

  constructor(
    private readonly server: Server,
    private readonly flags: Partial<MemoryProtocolFlags>,
    private readonly onCommit?: (commit: ClientCommit) => void,
    private readonly onSessionId?: (sessionId: string) => void,
    private readonly onServerMessage?: (message: unknown) => void,
  ) {}

  async create(
    space: MemorySpace,
    signer?: Signer,
    mountOptions: MemoryClient.MountOptions = {},
  ) {
    const inner = MemoryClient.loopback(this.server);
    const tap = this.onServerMessage;
    const transport: typeof inner = tap === undefined ? inner : {
      send: (payload: string) => inner.send(payload),
      close: () => inner.close(),
      setReceiver: (next: (payload: string) => void) => {
        inner.setReceiver((payload) => {
          try {
            tap(decodeMemoryBoundary(payload));
          } catch {
            // A payload the boundary cannot decode is the client's problem,
            // not the tap's; never let the tap break delivery.
          }
          next(payload);
        });
      },
      setCloseReceiver: (next: () => void) => inner.setCloseReceiver?.(next),
    };
    const client = await MemoryClient.connect({
      transport,
      protocolFlags: this.flags,
    });
    const session = await client.mount(
      space,
      mountOptions,
      (_space, _session, context) => ({
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
        },
        authorization: { principal: signer?.did() },
      }),
    );
    this.onSessionId?.(
      (session as unknown as { sessionId: string }).sessionId,
    );
    if (this.onCommit !== undefined) {
      const transact = session.transact.bind(session);
      session.transact = (commit) => {
        this.onCommit!(structuredClone(commit));
        return transact(commit);
      };
    }
    return { client, session };
  }
}

export class LoopbackStorageManager extends StorageManager {
  static connectTo(
    server: Server,
    flags: Partial<MemoryProtocolFlags>,
    options: Omit<StorageOptions, "memoryHost" | "spaceHostMap">,
    onCommit?: (commit: ClientCommit) => void,
    onSessionId?: (sessionId: string) => void,
    onServerMessage?: (message: unknown) => void,
  ): LoopbackStorageManager {
    return new LoopbackStorageManager(
      { ...options, memoryHost: new URL("memory://session-lane-gate") },
      new LoopbackSessionFactory(
        server,
        flags,
        onCommit,
        onSessionId,
        onServerMessage,
      ),
    );
  }
}

export type GateClient = {
  identity: Identity;
  did: string;
  userLaneKey: string;
  storage: LoopbackStorageManager;
  runtime: Runtime;
  commits: ClientCommit[];
  /** Every scopeKey/contextKey string any server→client message carried. */
  wireKeys: string[];
  /** Set once the space session mounts (first sync/start). */
  sessionId: () => string;
  sessionLaneKey: () => string;
};

/** Everything a wire frame may say about an instance's identity: the values
 * of every `scopeKey` and claim-shaped `contextKey` in a decoded
 * server→client message, collected recursively. */
export const collectWireScopeAndContextKeys = (
  value: unknown,
  into: string[],
): void => {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) collectWireScopeAndContextKeys(entry, into);
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (
      (key === "scopeKey" || key === "contextKey") &&
      typeof entry === "string"
    ) {
      into.push(entry);
    }
    collectWireScopeAndContextKeys(entry, into);
  }
};

export const openGateClient = async (
  server: Server,
  flags: Partial<MemoryProtocolFlags>,
  serverPrimary: boolean,
  identity?: Identity,
): Promise<GateClient> => {
  const clientIdentity = identity ??
    await Identity.generate({ implementation: "noble" });
  const commits: ClientCommit[] = [];
  const wireKeys: string[] = [];
  let mountedSessionId: string | undefined;
  const storage = LoopbackStorageManager.connectTo(
    server,
    flags,
    { as: clientIdentity },
    (commit) => commits.push(commit),
    (sessionId) => {
      mountedSessionId = sessionId;
    },
    (message) => collectWireScopeAndContextKeys(message, wireKeys),
  );
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
    experimental: {
      persistentSchedulerState: true,
      ...(serverPrimary ? { serverPrimaryExecution: true } : {}),
    },
  });
  const sessionId = () => {
    assertExists(mountedSessionId, "the gate client never mounted a session");
    return mountedSessionId;
  };
  return {
    identity: clientIdentity,
    did: clientIdentity.did(),
    userLaneKey: userExecutionContextKey(clientIdentity.did()),
    storage,
    runtime,
    commits,
    wireKeys,
    sessionId,
    sessionLaneKey: () =>
      sessionExecutionContextKey(clientIdentity.did(), sessionId()),
  };
};

export const GATE_BARRIER_TIMEOUT_MS = 60_000;

/** Bounded poll over a monotonic condition (server counters, replica
 * convergence). No fixed sleeps: the deadline only bounds the wait, progress
 * is driven by the observed state itself. */
export const waitForCondition = async (
  name: string,
  condition: () => boolean | Promise<boolean>,
  detail?: () => unknown,
  options?: { timeoutMs?: number; pollMs?: number },
): Promise<void> => {
  const deadline = Date.now() + (options?.timeoutMs ?? GATE_BARRIER_TIMEOUT_MS);
  const pollMs = options?.pollMs ?? 25;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(
        `${name} timed out${
          detail === undefined ? "" : `: ${JSON.stringify(detail())}`
        }`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
};

/**
 * One poll loop over several named monotonic conditions, recording the time
 * at which each first held. The latency gate's per-round barrier: one
 * foreign write settles across several lanes, and the gate needs both the
 * full-settlement time (the last lane) and the SPACE lane's own settlement
 * time (CA11 names it specifically) from the same round without re-driving
 * the workload per lane.
 */
export const waitForConditionsTimed = async (
  name: string,
  conditions: ReadonlyMap<string, () => boolean>,
  detail?: () => unknown,
  options?: { timeoutMs?: number; pollMs?: number },
): Promise<Map<string, number>> => {
  const startedAt = performance.now();
  const deadline = Date.now() + (options?.timeoutMs ?? GATE_BARRIER_TIMEOUT_MS);
  const pollMs = options?.pollMs ?? 5;
  const satisfiedAt = new Map<string, number>();
  while (satisfiedAt.size < conditions.size) {
    for (const [label, condition] of conditions) {
      if (!satisfiedAt.has(label) && condition()) {
        satisfiedAt.set(label, performance.now() - startedAt);
      }
    }
    if (satisfiedAt.size === conditions.size) break;
    if (Date.now() > deadline) {
      throw new Error(
        `${name} timed out; satisfied ${
          JSON.stringify([...satisfiedAt.keys()])
        } of ${JSON.stringify([...conditions.keys()])}${
          detail === undefined ? "" : `: ${JSON.stringify(detail())}`
        }`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return satisfiedAt;
};

/**
 * Deterministic teardown barrier for every test that spawns the real Deno
 * executor Worker — the FW7 discipline, verbatim from C1.9/C2.9:
 * terminating the executor Worker races the Deno event loop's own
 * resolution check, and a pending no-op timer held across the test keeps
 * the loop refed through the window. Cleared synchronously at test end, so
 * `--trace-leaks` sanitizers stay green.
 */
export const withExecutorTeardownBarrier = async <T>(
  fn: () => Promise<T>,
): Promise<T> => {
  const keepAlive = setInterval(() => {
    // Never expected to fire (tests finish or time out first); the pending
    // timer itself is the barrier.
  }, 60_000);
  try {
    return await fn();
  } finally {
    clearInterval(keepAlive);
  }
};

/** Set one field of a piece's argument/result document from `client`. */
export const setGateField = async (
  client: GateClient,
  resultLink: unknown,
  field: string,
  value: unknown,
): Promise<void> => {
  const tx = client.runtime.edit();
  client.runtime
    // deno-lint-ignore no-explicit-any
    .getCellFromLink(resultLink as any)
    .withTx(tx)
    .key(field)
    .set(value);
  const { error } = await tx.commit();
  if (error !== undefined) {
    throw new Error(`setGateField(${field}) failed: ${String(error)}`);
  }
};

/** Pull one key of a piece's result document as seen by `client`. The
 * explicit `sync()` first fetches the current upstream revision — a headless
 * client polling between its own commits has no UI-driven live query to
 * refresh a list another client just merged into (the browser stack's render
 * queries do this continuously; `array-push-mergeable.test.ts` reads durable
 * state the same sync-then-pull way). */
export const readGateKey = async (
  client: GateClient,
  resultLink: unknown,
  key: string,
): Promise<unknown> => {
  // deno-lint-ignore no-explicit-any
  const cell = client.runtime.getCellFromLink(resultLink as any).key(key);
  await cell.sync();
  return await cell.pull();
};

/** Percentile over recorded latency samples (nearest-rank; `q` in [0,1]).
 * Small fixed sample counts are the point — with n=12 the p95 is the max,
 * which is exactly the conservatism a generous structural ceiling wants. */
export const percentile = (samples: readonly number[], q: number): number => {
  if (samples.length === 0) {
    throw new Error("percentile over zero samples");
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(q * sorted.length) - 1),
  );
  return sorted[rank];
};

/**
 * Serve a gate-owned memory Server over a localhost WebSocket — the
 * standalone server's socket plumbing (memory/v2/standalone.ts), applied to
 * a Server THIS GATE constructed. StandaloneMemoryServer deliberately owns
 * its Server (no accessor, no protocolFlags/store options), but the C2.10
 * gates need all three: the execution protocol flags (session lanes
 * negotiate the context-lattice-claims subcapability), the executionStats /
 * accepted-commit taps for assertions, and the SharedExecutionPool attached
 * to the same Server object. Worker-realm clients (multi-runtime-harness
 * sessions — one full production client stack per realm) connect to the
 * returned URL exactly as they would to a toolshed.
 */
export const serveGateMemoryWebSocket = (
  server: Server,
): { url: URL; close: () => Promise<void> } => {
  const http = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    (request) => {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("memory websocket endpoint", { status: 200 });
      }
      const { socket, response } = Deno.upgradeWebSocket(request);
      const connection = server.connect((message) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(encodeMemoryBoundary(message));
        }
      });
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") {
          socket.close(1003, "memory websocket expects text frames");
          connection.close();
          return;
        }
        connection.receive(event.data).catch(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.close(1011, "memory websocket receive failure");
          }
          connection.close();
        });
      });
      socket.addEventListener("close", () => connection.close());
      socket.addEventListener("error", () => connection.close());
      return response;
    },
  );
  const address = http.addr as Deno.NetAddr;
  return {
    url: new URL(`http://127.0.0.1:${address.port}/`),
    close: async () => {
      await http.shutdown();
    },
  };
};
