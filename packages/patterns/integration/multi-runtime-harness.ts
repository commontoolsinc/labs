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
import type {
  RuntimeDiagnosticsSnapshot,
  TrustedUiDescriptor,
  WorkerRequest,
  WorkerResponse,
} from "./multi-runtime-worker.ts";

export type { TrustedUiDescriptor };
export type { RuntimeDiagnosticsSnapshot };

export interface MultiRuntimeSessionSpec {
  /** Label used in error messages and as the identity passphrase seed. */
  label: string;
  /**
   * Identity for this session. Pass the same Identity in two specs to model
   * one user with two concurrent sessions (e.g. two browser tabs).
   */
  identity?: Identity;
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

class WorkerClient {
  #worker: Worker;
  #nextId = 1;
  #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
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
          new Error(`[${this.label}] ${event.data.error}`),
        );
      } else {
        pending.resolve(event.data.ok);
      }
    };
    this.#worker.onerror = (event) => {
      const error = new Error(`[${this.label}] worker error: ${event.message}`);
      for (const pending of this.#pending.values()) {
        pending.reject(error);
      }
      this.#pending.clear();
    };
  }

  call(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.#nextId++;
    const request: WorkerRequest = { id, cmd, args };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new Error(
            `[${this.label}] ${cmd} timed out after ${RPC_TIMEOUT_MS}ms`,
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
      pending.reject(new Error(`[${this.label}] worker terminated`));
    }
    this.#pending.clear();
  }
}

export class MultiRuntimeSession {
  readonly label: string;
  readonly identity: Identity;
  #client: WorkerClient;

  constructor(label: string, identity: Identity, client: WorkerClient) {
    this.label = label;
    this.identity = identity;
    this.#client = client;
  }

  /**
   * Send an event to a handler stream exposed on the piece result. Pass
   * `trustedUi` to emulate a genuine user interaction on a trusted CFC
   * surface (required for trusted-action handlers).
   */
  async send(
    handler: string,
    event: unknown = {},
    trustedUi?: TrustedUiDescriptor,
  ): Promise<void> {
    await this.#client.call("send", { handler, event, trustedUi });
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

  /** Read a value from the piece result, pulling fresh state first. */
  async read(path: (string | number)[] = []): Promise<unknown> {
    return await this.#client.call("read", { path });
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

  async idle(): Promise<void> {
    await this.#client.call("idle");
  }

  /** Capture scheduler graph, settle stats history, and action run trace. */
  async diagnostics(): Promise<RuntimeDiagnosticsSnapshot> {
    return await this.#client.call("diagnostics") as RuntimeDiagnosticsSnapshot;
  }

  /** Per-logger message counts (logger name -> key -> {total,...}). */
  async loggerCounts(): Promise<
    Record<string, Record<string, { total: number }>> & { total: number }
  > {
    return await this.#client.call("loggerCounts") as
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
}

export class MultiRuntimeHarness {
  readonly sessions: MultiRuntimeSession[];
  readonly pieceId: string;
  #server?: StandaloneMemoryServer;

  private constructor(
    sessions: MultiRuntimeSession[],
    pieceId: string,
    server?: StandaloneMemoryServer,
  ) {
    this.sessions = sessions;
    this.pieceId = pieceId;
    this.#server = server;
  }

  static async create(
    options: MultiRuntimeHarnessOptions,
  ): Promise<MultiRuntimeHarness> {
    if (options.sessions.length === 0) {
      throw new Error("MultiRuntimeHarness needs at least one session");
    }
    const spaceName = options.spaceName ?? crypto.randomUUID();
    const server = options.apiUrl ? undefined : StandaloneMemoryServer.start();
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
        await client.call("init", {
          rawIdentity: identity.serialize(),
          spaceName,
          apiUrl,
          diagnostics: options.diagnostics === true,
        });
        sessions.push(
          new MultiRuntimeSession(normalized.label, identity, client),
        );
      }

      // A throwaway bootstrap worker creates the piece, then every test
      // session opens it BY ID from storage. This mirrors production: each
      // client loads the pattern through a verified load (required for
      // trusted-action CFC writes), and no session holds special in-memory
      // compile state.
      bootstrap = new WorkerClient("bootstrap");
      await bootstrap.call("init", {
        rawIdentity: sessions[0].identity.serialize(),
        spaceName,
        apiUrl,
        diagnostics: options.diagnostics === true,
      });
      const { pieceId } = await bootstrap.call("createPiece", {
        programPath: options.programPath,
        rootPath: options.rootPath,
        input: options.input,
      }) as { pieceId: string };
      await bootstrap.call("dispose");
      bootstrap.terminate();
      bootstrap = undefined;

      for (const session of sessions) {
        await session.client().call("openPiece", { pieceId });
      }

      return new MultiRuntimeHarness(sessions, pieceId, server);
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
        console.warn(`Failed to dispose session "${session.label}":`, error);
      });
    }
    await this.#server?.close();
  }
}
