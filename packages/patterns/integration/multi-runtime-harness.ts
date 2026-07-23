/**
 * Multi-runtime pattern test harness.
 *
 * Runs the same piece in SEVERAL runtimes — one per (identity, session) pair,
 * each in its own Deno Worker realm — all backed by one shared storage
 * server. This is the headless equivalent of multiple users (or multiple
 * tabs of one user) having the same piece open simultaneously, and is the
 * only way to meaningfully exercise `PerUser` / `PerSession` scoped state
 * and cross-client reactivity in a pattern test:
 *
 * - distinct identities → distinct `user:<did>` storage partitions
 * - distinct harness sessions → distinct `session:<did>:<id>` partitions
 * - `PerSpace` state is shared and propagates via subscription push
 *
 * Workers are essential, not an optimization: one JS realm cannot host two
 * runtimes (verified-load registries, frame stacks and similar module-level
 * state cross-talk), and production never does — every browser tab or CLI
 * process is its own realm. The storage server is self-hosted in-process
 * (@commonfabric/memory/v2/standalone), so no toolshed is needed; pass
 * `apiUrl` to target a running toolshed instead.
 */

import { Identity } from "@commonfabric/identity";
import { StandaloneMemoryServer } from "@commonfabric/memory/v2/standalone";
import type { CommitTelemetrySnapshot } from "@commonfabric/memory/v2/server";
import { setPersistentSchedulerStateConfig } from "@commonfabric/memory/v2";
import { experimentalOptionsFromEnv } from "@commonfabric/runner";
import type {
  RuntimeDiagnosticsSnapshot,
  RuntimeDiagnosticsSummary,
  RuntimeTelemetrySnapshot,
  TopicsDiagnosticsChurnTotals,
  TopicsDiagnosticsCrossrefValidation,
  TopicsDiagnosticsNoopOutcome,
  TopicsDiagnosticsOperationOutcome,
  TopicsDiagnosticsSummary,
  TrustedUiDescriptor,
  WorkerRequest,
  WorkerResponse,
} from "./multi-runtime-worker.ts";

// The self-hosted storage server lives in THIS realm, while every runtime
// lives in a worker realm whose Runtime constructor propagates the
// EXPERIMENTAL_* env flags into the memory module's ambient config. No
// Runtime is ever constructed in the harness realm, so a flag-ON test run
// would otherwise leave the SERVER side of the flag off — a client/server
// capability skew the harness does not intend to model (skewed peers now
// degrade gracefully, so the suite would silently test flag-off semantics).
// Mirror toolshed (whose in-process Runtime sets the ambient flag for its
// memory route) by propagating the canonical env mapping. Re-asserted per
// harness creation: any Runtime constructed later in this realm re-derives
// the ambient flag from ITS options and would stomp a load-time value.
function propagateExperimentalEnvToServerRealm(): void {
  const experimental = experimentalOptionsFromEnv(Deno.env.get);
  if (experimental.persistentSchedulerState !== undefined) {
    setPersistentSchedulerStateConfig(experimental.persistentSchedulerState);
  }
}

export type { TrustedUiDescriptor };
export type { RuntimeDiagnosticsSummary };
export type { RuntimeDiagnosticsSnapshot };
export type { RuntimeTelemetrySnapshot };
export type { CommitTelemetrySnapshot };
export type {
  TopicsDiagnosticsChurnTotals,
  TopicsDiagnosticsCrossrefValidation,
  TopicsDiagnosticsNoopOutcome,
  TopicsDiagnosticsOperationOutcome,
  TopicsDiagnosticsSummary,
};

export interface MultiRuntimeSessionSpec {
  /** Label used in error messages and as the identity passphrase seed. */
  label: string;
  /**
   * Identity for this session. Pass the same Identity in two specs to model
   * one user with two concurrent sessions (e.g. two browser tabs).
   */
  identity?: Identity;
  /**
   * Test-only network shaping: delay every storage WebSocket frame (both
   * directions) in this session's realm by this many milliseconds. Reproduces
   * multiplayer contention (optimistic pipelining, conflict storms) that
   * near-zero in-process latency hides.
   */
  wsDelayMs?: number;
}

export interface MultiRuntimeHarnessOptions {
  /** Path to the pattern entry file (e.g. `<dir>/main.tsx`). */
  programPath: string;
  /** Module-resolution root, usually the `packages/patterns` directory. */
  rootPath: string;
  /** Optional initial pattern input for the bootstrap-created piece. */
  input?: Record<string, unknown>;
  /** Enable scheduler graph/stats/action diagnostics for this harness run. */
  diagnostics?: boolean;
  /** Keep Topics diagnostic data in workers; parent receives fixed aggregates only. */
  aggregateOnlyDiagnostics?: boolean;
  sessions: (string | MultiRuntimeSessionSpec)[];
  spaceName?: string;
  /**
   * When set, sessions talk to a running toolshed at this URL instead of the
   * self-hosted in-process storage server.
   */
  apiUrl?: URL;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const RPC_TIMEOUT_MS = 120_000;

function hasExactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value).sort();
  return keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]);
}

function assertAggregateBootstrapResponse(
  value: unknown,
  kind: "empty" | "ready" | "success",
): void {
  const valid = kind === "empty"
    ? hasExactKeys(value, [])
    : kind === "ready"
    ? hasExactKeys(value, ["ok", "ready"]) && value.ok === true &&
      value.ready === true
    : hasExactKeys(value, ["ok"]) && value.ok === true;
  if (!valid) throw new Error("operation-failed");
}

class WorkerClient {
  #worker: Worker;
  #nextId = 1;
  #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  #aggregateOnlyDiagnostics = false;
  readonly label: string;

  constructor(label: string) {
    this.label = label;
    this.#worker = new Worker(
      new URL("./multi-runtime-worker.ts", import.meta.url),
      { type: "module", name: `multi-runtime:${label}` },
    );
    this.#worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const pending = this.#pending.get(event.data.id);
      if (!pending) return;
      this.#pending.delete(event.data.id);
      if ("error" in event.data) {
        pending.reject(
          new Error(
            this.#aggregateOnlyDiagnostics
              ? "operation-failed"
              : `[${this.label}] ${event.data.error}`,
          ),
        );
      } else {
        pending.resolve(event.data.ok);
      }
    };
    this.#worker.onerror = (event) => {
      if (this.#aggregateOnlyDiagnostics) event.preventDefault();
      const error = new Error(
        this.#aggregateOnlyDiagnostics
          ? "operation-failed"
          : `[${this.label}] worker error: ${event.message}`,
      );
      for (const pending of this.#pending.values()) {
        pending.reject(error);
      }
      this.#pending.clear();
    };
  }

  setAggregateOnlyDiagnostics(value: boolean): void {
    this.#aggregateOnlyDiagnostics = value;
  }

  call(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.#nextId++;
    const request: WorkerRequest = { id, cmd, args };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new Error(
            this.#aggregateOnlyDiagnostics
              ? "operation-failed"
              : `[${this.label}] ${cmd} timed out after ${RPC_TIMEOUT_MS}ms`,
          ),
        );
      }, RPC_TIMEOUT_MS);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#worker.postMessage(request);
    });
  }

  terminate(): void {
    this.#worker.terminate();
    for (const pending of this.#pending.values()) {
      pending.reject(
        new Error(
          this.#aggregateOnlyDiagnostics
            ? "operation-failed"
            : `[${this.label}] worker terminated`,
        ),
      );
    }
    this.#pending.clear();
  }
}

export class MultiRuntimeSession {
  readonly label: string;
  readonly identity: Identity;
  #client: WorkerClient;
  #diagnosticMutationsEnabled: boolean;

  constructor(
    label: string,
    identity: Identity,
    client: WorkerClient,
    diagnosticMutationsEnabled: boolean,
  ) {
    this.label = label;
    this.identity = identity;
    this.#client = client;
    this.#diagnosticMutationsEnabled = diagnosticMutationsEnabled;
  }

  /**
   * Send an event to a handler stream exposed on the piece result. Pass
   * `trustedUi` to emulate a genuine user interaction on a trusted CFC
   * surface (required for trusted-action handlers).
   */
  async send(
    target: string | (string | number)[],
    event: unknown = {},
    trustedUi?: TrustedUiDescriptor,
    opts: { idle?: boolean } = {},
  ): Promise<void> {
    await this.#client.call("send", {
      target,
      event,
      trustedUi,
      idle: opts.idle,
    });
  }

  /**
   * Set a cell reached from the piece result by `path`, exactly like a UI
   * `$value` binding: one fresh edit tx and a single un-retried commit (the
   * `handleCellSet` path). Returns the commit outcome so tests can observe
   * conflicts. Pass `idle: false` to leave this runtime un-settled (preserves
   * a stale local replica for own-write-race / no-op repros).
   */
  async set(
    path: (string | number)[],
    value: unknown,
    opts: { idle?: boolean } = {},
  ): Promise<{ ok: boolean; error?: { name?: string; message?: string } }> {
    return await this.#client.call("set", {
      path,
      value,
      idle: opts.idle,
    }) as { ok: boolean; error?: { name?: string; message?: string } };
  }

  /**
   * Diagnostic-only operation for a result field that resolves directly to
   * `['value', stringKey]` in its containing storage document. It preserves
   * that document's sibling fields and replaces only `stringKey` with raw
   * array data through a single low-level write at `['value']`, intentionally
   * producing a whole-root memory patch rather than `Cell.set`'s nested diff.
   * It is not a general-purpose mutation API.
   */
  async prepareContainingDocumentValueRoot(
    path: (string | number)[],
    value: readonly unknown[],
    opts: { idle?: boolean } = {},
  ): Promise<void> {
    this.#assertDiagnosticMutationsEnabled();
    await this.#client.call("prepareContainingDocumentValueRoot", {
      path,
      value,
      idle: opts.idle,
    });
  }

  /** Commit exactly one previously prepared diagnostic root replacement. */
  async commitPreparedContainingDocumentValueRoot(): Promise<
    { ok: boolean; error?: { name?: string; message?: string } }
  > {
    this.#assertDiagnosticMutationsEnabled();
    return await this.#client.call(
      "commitPreparedContainingDocumentValueRoot",
    ) as {
      ok: boolean;
      error?: { name?: string; message?: string };
    };
  }

  /**
   * Append `value` to the array cell reached by `path`, exactly like a
   * `CellHandle.push`: read-modify-write that keeps its read as a compare-and-set
   * precondition (the `handleCellPush` path), so a concurrent push conflicts
   * rather than being clobbered — unlike the blind `set` above.
   */
  async push(
    path: (string | number)[],
    value: unknown,
    opts: { idle?: boolean } = {},
  ): Promise<{ ok: boolean; error?: { name?: string; message?: string } }> {
    return await this.#client.call("push", {
      path,
      value,
      idle: opts.idle,
    }) as { ok: boolean; error?: { name?: string; message?: string } };
  }

  /**
   * Read a value from the piece result, pulling fresh state first. `omitKeys`
   * removes named object fields during transfer when a derived graph would be
   * recursive or unnecessarily large.
   */
  async read(
    path: (string | number)[] = [],
    opts: { omitKeys?: readonly string[] } = {},
  ): Promise<unknown> {
    return await this.#client.call("read", {
      path,
      omitKeys: opts.omitKeys,
    });
  }

  /** Read the RAW stored value at `path` (links resolved to the target cell,
   *  no result-schema shaping) — for state the declared schema does not
   *  carry, e.g. a query result's `requestHash`. */
  async readRaw(path: (string | number)[] = []): Promise<unknown> {
    return await this.#client.call("readRaw", { path });
  }

  /** Inspect the normalized link (id, space, scope) at `path` in the result. */
  async link(
    path: (string | number)[] = [],
  ): Promise<{ id: string; space: string; scope: string; path: string[] }> {
    return await this.#client.call("link", { path }) as {
      id: string;
      space: string;
      scope: string;
      path: string[];
    };
  }

  /**
   * Raw replica read at an explicit storage address — bypasses the piece
   * result / schema / link resolution. Distinguishes "replica lacks the doc"
   * from "schema-aware read fails to resolve it".
   */
  async rawRead(
    address: {
      id: string;
      space: string;
      path?: (string | number)[];
      scope?: unknown;
    },
  ): Promise<{ ok: boolean; value?: unknown; error?: string }> {
    return await this.#client.call("rawRead", address) as {
      ok: boolean;
      value?: unknown;
      error?: string;
    };
  }

  async idle(): Promise<void> {
    await this.#client.call("idle");
  }

  async settled(): Promise<void> {
    await this.#client.call("settled");
  }

  async delayedFramesDrained(): Promise<void> {
    await this.#client.call("delayedFramesDrained");
  }

  /** Capture scheduler graph, settle stats history, and action run trace. */
  async diagnostics(
    opts: { idle?: boolean } = {},
  ): Promise<RuntimeDiagnosticsSnapshot> {
    return await this.#client.call(
      "diagnostics",
      opts,
    ) as RuntimeDiagnosticsSnapshot;
  }

  /** Capture content-free scheduler aggregates inside the worker. */
  async diagnosticsSummary(
    opts: { idle?: boolean } = {},
  ): Promise<RuntimeDiagnosticsSummary> {
    return await this.#client.call(
      "diagnosticsSummary",
      opts,
    ) as RuntimeDiagnosticsSummary;
  }

  async diagnosticsActivityGeneration(): Promise<number> {
    return (await this.#client.call(
      "diagnosticsActivityGeneration",
    ) as { generation: number }).generation;
  }

  /** Aggregate-only Topics diagnostics; no pattern values or links cross IPC. */
  async topicsDiagnosticsSummary(): Promise<TopicsDiagnosticsSummary> {
    return await this.#client.call(
      "topicsDiagnosticsSummary",
    ) as TopicsDiagnosticsSummary;
  }

  async topicsDiagnosticsChurn(
    opts: { idle?: boolean } = {},
  ): Promise<TopicsDiagnosticsChurnTotals> {
    return await this.#client.call(
      "topicsDiagnosticsChurn",
      opts,
    ) as TopicsDiagnosticsChurnTotals;
  }

  async topicsDiagnosticsSend(
    target: string | (string | number)[],
    event: unknown = {},
    opts: { idle?: boolean } = {},
  ): Promise<TopicsDiagnosticsOperationOutcome> {
    return await this.#client.call("topicsDiagnosticsSend", {
      target,
      event,
      idle: opts.idle,
    }) as TopicsDiagnosticsOperationOutcome;
  }

  async topicsDiagnosticsSet(
    path: (string | number)[],
    value: unknown,
    opts: { idle?: boolean } = {},
  ): Promise<TopicsDiagnosticsOperationOutcome> {
    return await this.#client.call("topicsDiagnosticsSet", {
      path,
      value,
      idle: opts.idle,
    }) as TopicsDiagnosticsOperationOutcome;
  }

  async topicsDiagnosticsNoop(
    topicIndex: number,
    opts: { idle?: boolean } = {},
  ): Promise<TopicsDiagnosticsNoopOutcome> {
    return await this.#client.call("topicsDiagnosticsNoop", {
      topicIndex,
      idle: opts.idle,
    }) as TopicsDiagnosticsNoopOutcome;
  }

  async topicsDiagnosticsPrepareReversedRoot(
    opts: { idle?: boolean } = {},
  ): Promise<TopicsDiagnosticsOperationOutcome> {
    this.#assertDiagnosticMutationsEnabled();
    return await this.#client.call("topicsDiagnosticsPrepareReversedRoot", {
      idle: opts.idle,
    }) as TopicsDiagnosticsOperationOutcome;
  }

  async topicsDiagnosticsCommitPreparedRoot(): Promise<
    TopicsDiagnosticsOperationOutcome
  > {
    this.#assertDiagnosticMutationsEnabled();
    return await this.#client.call(
      "topicsDiagnosticsCommitPreparedRoot",
    ) as TopicsDiagnosticsOperationOutcome;
  }

  async topicsDiagnosticsCreateCrossref(
    sourceIndex: number,
    targetIndex: number,
    opts: { idle?: boolean } = {},
  ): Promise<TopicsDiagnosticsOperationOutcome> {
    return await this.#client.call("topicsDiagnosticsCreateCrossref", {
      sourceIndex,
      targetIndex,
      idle: opts.idle,
    }) as TopicsDiagnosticsOperationOutcome;
  }

  async topicsDiagnosticsValidateCrossrefs(
    topicCount: number,
  ): Promise<TopicsDiagnosticsCrossrefValidation> {
    return await this.#client.call("topicsDiagnosticsValidateCrossrefs", {
      topicCount,
    }) as TopicsDiagnosticsCrossrefValidation;
  }

  async topicsDiagnosticsConvergenceBegin(
    channel: string,
    participants: number,
  ): Promise<
    { ok: true; ready: true } | { ok: false; error: "operation-failed" }
  > {
    return await this.#client.call("topicsDiagnosticsConvergenceBegin", {
      channel,
      participants,
    }) as { ok: true; ready: true } | { ok: false; error: "operation-failed" };
  }

  async topicsDiagnosticsConvergencePublish(channel: string): Promise<
    { ok: true } | { ok: false; error: "operation-failed" }
  > {
    return await this.#client.call("topicsDiagnosticsConvergencePublish", {
      channel,
    }) as { ok: true } | { ok: false; error: "operation-failed" };
  }

  async topicsDiagnosticsConvergenceFinish(): Promise<
    | {
      ok: true;
      converged: boolean;
      summary: { topics: number[]; comments: number[]; links: number[] };
    }
    | { ok: false; error: "operation-failed" }
  > {
    return await this.#client.call("topicsDiagnosticsConvergenceFinish") as
      | {
        ok: true;
        converged: boolean;
        summary: { topics: number[]; comments: number[]; links: number[] };
      }
      | { ok: false; error: "operation-failed" };
  }

  async topicsDiagnosticsConvergenceCancel(): Promise<
    { ok: true } | { ok: false; error: "operation-failed" }
  > {
    return await this.#client.call("topicsDiagnosticsConvergenceCancel") as {
      ok: true;
    } | { ok: false; error: "operation-failed" };
  }

  /**
   * Atomically collect and reset local scheduler telemetry since the previous
   * snapshot. Available only when the harness was created with diagnostics.
   */
  async telemetry(): Promise<RuntimeTelemetrySnapshot> {
    return await this.#client.call("telemetry") as RuntimeTelemetrySnapshot;
  }

  /** Per-logger message counts (logger name -> key -> {total,...}). */
  async loggerCounts(opts: { idle?: boolean } = {}): Promise<
    Record<string, Record<string, { total: number }>> & { total: number }
  > {
    return await this.#client.call("loggerCounts", opts) as
      & Record<
        string,
        Record<string, { total: number }>
      >
      & { total: number };
  }

  async disposeSession(): Promise<void> {
    try {
      await this.#client.call("dispose");
    } finally {
      this.#client.terminate();
    }
  }

  /** @internal */
  client(): WorkerClient {
    return this.#client;
  }

  #assertDiagnosticMutationsEnabled(): void {
    if (!this.#diagnosticMutationsEnabled) {
      throw new Error(
        "containing-document root replacement requires a local diagnostics harness",
      );
    }
  }
}

export class MultiRuntimeHarness {
  readonly sessions: MultiRuntimeSession[];
  readonly pieceId: string;
  #server?: StandaloneMemoryServer;
  #diagnosticsEnabled: boolean;
  #aggregateOnlyDiagnostics: boolean;

  private constructor(
    sessions: MultiRuntimeSession[],
    pieceId: string,
    server?: StandaloneMemoryServer,
    diagnosticsEnabled = false,
    aggregateOnlyDiagnostics = false,
  ) {
    this.sessions = sessions;
    this.pieceId = pieceId;
    this.#server = server;
    this.#diagnosticsEnabled = diagnosticsEnabled;
    this.#aggregateOnlyDiagnostics = aggregateOnlyDiagnostics;
  }

  static async create(
    options: MultiRuntimeHarnessOptions,
  ): Promise<MultiRuntimeHarness> {
    if (options.sessions.length === 0) {
      throw new Error("MultiRuntimeHarness needs at least one session");
    }
    if (options.aggregateOnlyDiagnostics && options.apiUrl) {
      throw new Error(
        "aggregate-only diagnostics require the local in-process memory server",
      );
    }
    propagateExperimentalEnvToServerRealm();
    const spaceName = options.spaceName ?? crypto.randomUUID();
    const server = options.apiUrl ? undefined : StandaloneMemoryServer.start({
      commitTelemetry: options.diagnostics === true,
      aggregateOnlyDiagnostics: options.aggregateOnlyDiagnostics === true,
    });
    const apiUrl = (options.apiUrl ?? server!.url).href;

    const sessions: MultiRuntimeSession[] = [];
    let bootstrap: WorkerClient | undefined;
    try {
      for (const spec of options.sessions) {
        const normalized: MultiRuntimeSessionSpec = typeof spec === "string"
          ? { label: spec }
          : spec;
        const identity = normalized.identity ??
          await Identity.fromPassphrase(
            `multi-runtime-harness ${normalized.label}`,
            { implementation: "noble" },
          );
        const client = new WorkerClient(normalized.label);
        client.setAggregateOnlyDiagnostics(
          options.aggregateOnlyDiagnostics === true,
        );
        const initialized = await client.call("init", {
          rawIdentity: identity.serialize(),
          spaceName,
          apiUrl,
          diagnostics: options.diagnostics === true,
          aggregateOnlyDiagnostics: options.aggregateOnlyDiagnostics === true,
          diagnosticMutationsEnabled: options.diagnostics === true &&
            !options.apiUrl,
          ...(normalized.wsDelayMs !== undefined
            ? { wsDelayMs: normalized.wsDelayMs }
            : {}),
        });
        if (options.aggregateOnlyDiagnostics) {
          assertAggregateBootstrapResponse(initialized, "empty");
        }
        sessions.push(
          new MultiRuntimeSession(
            normalized.label,
            identity,
            client,
            options.diagnostics === true && !options.apiUrl,
          ),
        );
      }

      // A throwaway bootstrap worker creates the piece, then every test
      // session opens it BY ID from storage. This mirrors production: each
      // client loads the pattern through a verified load (required for
      // trusted-action CFC writes), and no session holds special in-memory
      // compile state.
      const bootstrapChannel = options.aggregateOnlyDiagnostics
        ? `topics-bootstrap-${crypto.randomUUID()}`
        : undefined;
      bootstrap = new WorkerClient("bootstrap");
      bootstrap.setAggregateOnlyDiagnostics(
        options.aggregateOnlyDiagnostics === true,
      );
      const bootstrapInitialized = await bootstrap.call("init", {
        rawIdentity: sessions[0].identity.serialize(),
        spaceName,
        apiUrl,
        diagnostics: options.diagnostics === true,
        aggregateOnlyDiagnostics: options.aggregateOnlyDiagnostics === true,
        aggregateBootstrapCreator: bootstrapChannel !== undefined,
        ...(bootstrapChannel
          ? {
            aggregateBootstrapChannel: bootstrapChannel,
            aggregateBootstrapParticipants: sessions.length,
          }
          : {}),
        diagnosticMutationsEnabled: false,
      });
      if (options.aggregateOnlyDiagnostics) {
        assertAggregateBootstrapResponse(bootstrapInitialized, "empty");
      }
      if (bootstrapChannel) {
        const prepared = await Promise.all(
          sessions.map((session) =>
            session.client().call("topicsDiagnosticsPrepareBootstrap", {
              channel: bootstrapChannel,
            })
          ),
        );
        for (const response of prepared) {
          assertAggregateBootstrapResponse(response, "ready");
        }
      }
      const created = await bootstrap.call("createPiece", {
        programPath: options.programPath,
        rootPath: options.rootPath,
        input: options.input,
      }) as { pieceId: string };
      if (bootstrapChannel) {
        assertAggregateBootstrapResponse(created, "success");
      }
      const bootstrapDisposed = await bootstrap.call("dispose");
      if (bootstrapChannel) {
        assertAggregateBootstrapResponse(bootstrapDisposed, "success");
      }
      bootstrap.terminate();
      bootstrap = undefined;

      if (bootstrapChannel) {
        const finished = await Promise.all(
          sessions.map((session) =>
            session.client().call("topicsDiagnosticsFinishBootstrap")
          ),
        );
        for (const response of finished) {
          assertAggregateBootstrapResponse(response, "success");
        }
      } else {
        for (const session of sessions) {
          await session.client().call("openPiece", {
            pieceId: created.pieceId,
          });
        }
      }

      return new MultiRuntimeHarness(
        sessions,
        bootstrapChannel ? "aggregate-only" : created.pieceId,
        server,
        options.diagnostics === true && !options.apiUrl,
        options.aggregateOnlyDiagnostics === true,
      );
    } catch (error) {
      bootstrap?.terminate();
      for (const session of sessions) {
        await session.disposeSession().catch(() => {});
      }
      await server?.close().catch(() => {});
      throw error;
    }
  }

  session(label: string): MultiRuntimeSession {
    const session = this.sessions.find((s) => s.label === label);
    if (!session) {
      throw new Error(`No session labeled "${label}"`);
    }
    return session;
  }

  /**
   * Atomically collect and reset canonical memory transact telemetry. This is
   * available only for local diagnostic harnesses: a remote toolshed cannot
   * provide an equivalent server-side snapshot.
   */
  memoryTelemetry(): CommitTelemetrySnapshot {
    if (!this.#server || !this.#diagnosticsEnabled) {
      throw new Error(
        "memoryTelemetry() is unavailable when MultiRuntimeHarness uses apiUrl",
      );
    }
    return this.#server.commitTelemetry();
  }

  /** Event-driven local diagnostic quiescence barrier; ordinary tests use settle(). */
  async diagnosticsBarrier(): Promise<void> {
    if (!this.#server || !this.#diagnosticsEnabled) {
      throw new Error(
        "diagnosticsBarrier() requires a local diagnostics harness",
      );
    }
    while (true) {
      const generationBeforeCycle = this.#server
        .diagnosticsActivityGeneration();
      const workerGenerationsBeforeCycle = await Promise.all(
        this.sessions.map((session) => session.diagnosticsActivityGeneration()),
      );
      await Promise.all(
        this.sessions.map((session) => session.delayedFramesDrained()),
      );
      await Promise.all(this.sessions.map((session) => session.settled()));
      await Promise.all(this.sessions.map((session) => session.idle()));
      await Promise.all(
        this.sessions.map((session) => session.delayedFramesDrained()),
      );
      await Promise.all(this.sessions.map((session) => session.settled()));
      await Promise.all(
        this.sessions.map((session) => session.delayedFramesDrained()),
      );
      await this.#server.flushDiagnosticsSessions();
      await Promise.all(this.sessions.map((session) => session.idle()));
      await Promise.all(this.sessions.map((session) => session.settled()));
      await Promise.all(
        this.sessions.map((session) => session.delayedFramesDrained()),
      );
      await this.#server.waitForDiagnosticsReceives();
      const workerGenerationsAfterCycle = await Promise.all(
        this.sessions.map((session) => session.diagnosticsActivityGeneration()),
      );
      if (
        generationBeforeCycle ===
          this.#server.diagnosticsActivityGeneration() &&
        workerGenerationsBeforeCycle.every((generation, index) =>
          generation === workerGenerationsAfterCycle[index]
        )
      ) {
        return;
      }
    }
  }

  /** Let all runtimes finish local work and exchange pending sync traffic. */
  async settle(rounds = 2): Promise<void> {
    for (let i = 0; i < rounds; i++) {
      await Promise.all(this.sessions.map((session) => session.idle()));
      // Give subscription pushes a macrotask to land before the next round.
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /**
   * Poll until `predicate` resolves truthy, settling between attempts.
   * Use for assertions about state that must cross runtimes.
   */
  async waitFor(
    description: string,
    predicate: () => Promise<boolean> | boolean,
    { timeout = DEFAULT_TIMEOUT_MS }: { timeout?: number } = {},
  ): Promise<void> {
    const startedAt = Date.now();
    let lastError: unknown;
    while (Date.now() - startedAt < timeout) {
      try {
        if (await predicate()) return;
      } catch (error) {
        lastError = error;
      }
      await this.settle(1);
    }
    throw new Error(
      `Timed out waiting for: ${description}` +
        (lastError ? ` (last error: ${lastError})` : ""),
    );
  }

  async dispose(): Promise<void> {
    for (const session of this.sessions) {
      await session.disposeSession().catch((error) => {
        if (!this.#aggregateOnlyDiagnostics) {
          console.warn(`Failed to dispose session "${session.label}":`, error);
        }
      });
    }
    await this.#server?.close();
  }
}
