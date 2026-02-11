/**
 * V2 Direct Transport - In-process transport for v2 memory protocol.
 *
 * Replaces the WebSocket transport (V2ProviderConnection) for local/emulated
 * usage. Commands are processed synchronously against an in-memory V2Space.
 *
 * @module v2-direct-transport
 */

import { openV2Space, type V2Space } from "@commontools/memory/v2-space";
import { applyCommit } from "@commontools/memory/v2-commit";
import { executeSimpleQuery } from "@commontools/memory/v2-query";
import { SubscriptionManager } from "@commontools/memory/v2-subscription";
import { EMPTY } from "@commontools/memory/v2-reference";
import type {
  ClientCommit,
  EntityId,
  JSONValue,
  Operation,
  SpaceId,
} from "@commontools/memory/v2-types";
import type {
  InvocationId,
  UserOperation,
} from "@commontools/memory/v2-protocol";
import type { Reference } from "merkle-reference";
import type { V2Transport, V2TransportCallbacks } from "./v2-provider.ts";

// ---------------------------------------------------------------------------
// V2DirectTransport
// ---------------------------------------------------------------------------

export class V2DirectTransport implements V2Transport {
  /** Exposed for test compat (direct space manipulation). */
  readonly space: V2Space;
  readonly #subs: SubscriptionManager;
  readonly #onMessage: (msg: unknown) => void;
  /** Active subscription IDs */
  readonly #subIds = new Set<InvocationId>();

  constructor(_spaceId: SpaceId, callbacks: V2TransportCallbacks) {
    // Open an in-memory V2Space. Use a data: URL to get in-memory mode
    // (any non-file: protocol results in :memory: SQLite).
    this.space = openV2Space(new URL("data:,memory"));
    this.#subs = new SubscriptionManager();
    this.#onMessage = callbacks.onMessage;

    // Trigger onOpen on the next microtask (we're always "connected").
    queueMicrotask(() => callbacks.onOpen());
  }

  send(command: unknown): void {
    const cmd = command as Record<string, unknown>;
    const ability = cmd.cmd as string;
    const requestId = cmd.id as string | undefined;

    switch (ability) {
      case "/memory/transact":
        this.handleTransact(cmd, requestId);
        break;
      case "/memory/query":
        this.handleQuery(cmd, requestId);
        break;
      case "/memory/query/subscribe":
        this.handleSubscribe(cmd, requestId);
        break;
      case "/memory/query/unsubscribe":
        this.handleUnsubscribe(cmd, requestId);
        break;
    }
  }

  close(): Promise<void> {
    this.#subs.clear();
    this.#subIds.clear();
    this.space.close();
    return Promise.resolve();
  }

  // -------------------------------------------------------------------------
  // Command handlers
  // -------------------------------------------------------------------------

  private handleTransact(
    cmd: Record<string, unknown>,
    requestId?: string,
  ): void {
    try {
      const args = cmd.args as {
        reads: {
          confirmed: Array<{ id: EntityId; hash: string; version: number }>;
          pending: Array<{ id: EntityId; hash: string; fromCommit: string }>;
        };
        operations: UserOperation[];
        branch?: string;
        codeCID?: string;
      };

      const branch = args.branch ?? "";

      // Resolve user operations to full operations with parent references
      const operations = this.resolveOperations(branch, args.operations);

      // Build confirmed/pending reads
      const confirmedReads = (args.reads?.confirmed ?? []).map((r) => ({
        id: r.id,
        hash: r.hash as unknown as Reference,
        version: r.version,
      }));
      const pendingReads = (args.reads?.pending ?? []).map((r) => ({
        id: r.id,
        hash: r.hash as unknown as Reference,
        fromCommit: r.fromCommit as unknown as Reference,
      }));

      const clientCommit: ClientCommit = {
        reads: { confirmed: confirmedReads, pending: pendingReads },
        operations,
        ...(branch ? { branch } : {}),
        ...(args.codeCID
          ? { codeCID: args.codeCID as unknown as Reference }
          : {}),
      };

      const result = applyCommit(this.space.store, clientCommit);

      if ("ok" in result) {
        // Fan out subscription updates
        const updates = this.#subs.match(result.ok);
        for (const update of updates) {
          if (this.#subIds.has(update.subscriptionId)) {
            // Deliver as subscription update
            queueMicrotask(() =>
              this.#onMessage({
                the: "task/effect",
                of: update.subscriptionId,
                is: {
                  commit: update.commit,
                  revisions: update.revisions,
                },
              })
            );
          }
        }
        // Deliver success response asynchronously so the caller can
        // observe optimistic state before the confirmation arrives.
        queueMicrotask(() => this.#onMessage({ id: requestId, ok: result.ok }));
      } else {
        // Include actual entity values for conflicting entities so the
        // client can update its confirmed state after a conflict.
        const actuals = result.error.conflicts.map((c) => {
          const eid = c.id;
          const value = this.space.readEntity(branch, eid);
          const head = this.space.readHead(branch, eid);
          return {
            id: eid,
            value: value ?? undefined,
            version: head?.version ?? 0,
            hash: head?.factHash ?? "",
          };
        });
        // Deliver error response asynchronously so the caller can
        // observe optimistic state before the rejection arrives.
        queueMicrotask(() =>
          this.#onMessage({
            id: requestId,
            error: {
              name: "ConflictError",
              conflicts: result.error.conflicts,
              message: result.error.message,
              actuals,
            },
          })
        );
      }
    } catch (err) {
      console.error("V2DirectTransport.handleTransact error:", err);
      queueMicrotask(() =>
        this.#onMessage({
          id: requestId,
          error: {
            name: err instanceof Error ? err.name : "UnknownError",
            message: err instanceof Error ? err.message : String(err),
          },
        })
      );
    }
  }

  private handleQuery(
    cmd: Record<string, unknown>,
    requestId?: string,
  ): void {
    try {
      const args = cmd.args as {
        select: Record<string, Record<string, unknown>>;
        since?: number;
        branch?: string;
      };
      const result = executeSimpleQuery(this.space, {
        select: args.select,
        since: args.since,
        branch: args.branch,
      });
      this.#onMessage({ id: requestId, ok: result });
    } catch (err) {
      this.#onMessage({
        id: requestId,
        error: {
          name: "QueryError",
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  private handleSubscribe(
    cmd: Record<string, unknown>,
    requestId?: string,
  ): void {
    try {
      const args = cmd.args as {
        select: Record<string, Record<string, unknown>>;
        since?: number;
        branch?: string;
      };
      const nonce = (cmd as Record<string, unknown>).nonce as
        | string
        | undefined;
      const subId = (nonce
        ? `job:${nonce}`
        : requestId ?? `job:${crypto.randomUUID()}`) as InvocationId;

      this.#subs.add({
        id: subId,
        select: args.select,
        since: args.since ?? 0,
        branch: args.branch ?? "",
      });
      this.#subIds.add(subId);

      // Query initial state
      const initialState = executeSimpleQuery(this.space, {
        select: args.select,
        since: args.since,
        branch: args.branch,
      });

      // Send initial state as a response (V2Provider.onQueryResponse matches
      // messages with { ok: ... } and no id).
      this.#onMessage({ ok: initialState });
    } catch (err) {
      this.#onMessage({
        error: {
          name: "SubscribeError",
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  private handleUnsubscribe(
    cmd: Record<string, unknown>,
    requestId?: string,
  ): void {
    const args = cmd.args as { source: InvocationId };
    const removed = this.#subs.remove(args.source);
    this.#subIds.delete(args.source);
    this.#onMessage({ id: requestId, ok: { removed } });
  }

  // -------------------------------------------------------------------------
  // External data injection (for tests simulating other clients)
  // -------------------------------------------------------------------------

  /**
   * Inject data as if it came from another client. The data is applied to the
   * space and subscription updates are delivered, triggering "integrate"
   * notifications in V2Provider. This is NOT routed through the normal command
   * path, so no commit response is sent.
   */
  injectExternalCommit(
    entities: Array<{ id: EntityId; value: JSONValue }>,
  ): void {
    const branch = "";
    const operations: Operation[] = entities.map((e) => {
      const head = this.space.readHead(branch, e.id);
      const parent: Reference = head
        ? (head.factHash as unknown as Reference)
        : EMPTY(e.id);
      return { op: "set" as const, id: e.id, value: e.value, parent };
    });

    const clientCommit: ClientCommit = {
      reads: { confirmed: [], pending: [] },
      operations,
    };

    const result = applyCommit(this.space.store, clientCommit);
    if ("ok" in result) {
      const updates = this.#subs.match(result.ok);
      for (const update of updates) {
        if (this.#subIds.has(update.subscriptionId)) {
          queueMicrotask(() =>
            this.#onMessage({
              the: "task/effect",
              of: update.subscriptionId,
              is: {
                commit: update.commit,
                revisions: update.revisions,
              },
            })
          );
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private resolveOperations(
    branch: string,
    userOps: UserOperation[],
  ): Operation[] {
    return userOps.map((uop): Operation => {
      const head = this.space.readHead(branch, uop.id);
      const parent: Reference = head
        ? (head.factHash as unknown as Reference)
        : EMPTY(uop.id);

      switch (uop.op) {
        case "set":
          return { op: "set", id: uop.id, value: uop.value, parent };
        case "patch":
          return {
            op: "patch",
            id: uop.id,
            patches: uop.patches as never,
            parent,
          };
        case "delete":
          return { op: "delete", id: uop.id, parent };
        case "claim":
          return { op: "claim", id: uop.id, parent };
      }
    });
  }
}
