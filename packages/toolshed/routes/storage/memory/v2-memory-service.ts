/**
 * Memory v2 Service Layer
 *
 * Manages V2Space instances per space DID, providing transact, query,
 * and subscription operations for the v2 memory protocol.
 *
 * @module v2-memory-service
 */

import { openV2Space, type V2Space } from "@commontools/memory/v2-space";
import { applyCommit, V2ConflictError } from "@commontools/memory/v2-commit";
import { executeSimpleQuery } from "@commontools/memory/v2-query";
import { SubscriptionManager } from "@commontools/memory/v2-subscription";
import type {
  ClientCommit,
  Commit,
  EntityId,
  FactSet,
  Operation,
} from "@commontools/memory/v2-types";
import type {
  InvocationId,
  Selector,
  UserOperation,
} from "@commontools/memory/v2-protocol";
import { EMPTY } from "@commontools/memory/v2-reference";
import type { Reference } from "merkle-reference";
import env from "@/env.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SpaceEntry {
  space: V2Space;
  subs: SubscriptionManager;
  /** WebSocket -> set of subscription IDs owned by that socket */
  clientSubs: Map<WebSocket, Set<InvocationId>>;
}

export interface TransactArgs {
  reads: {
    confirmed: Array<{ id: EntityId; hash: string; version: number }>;
    pending: Array<{ id: EntityId; hash: string; fromCommit: string }>;
  };
  operations: UserOperation[];
  codeCID?: string;
  branch?: string;
}

export interface QueryArgs {
  select: Selector;
  since?: number;
  branch?: string;
}

export interface SubscribeArgs {
  id: InvocationId;
  select: Selector;
  since?: number;
  branch?: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class V2MemoryService {
  private spaces = new Map<string, SpaceEntry>();

  private getOrOpenSpace(spaceId: string): SpaceEntry {
    let entry = this.spaces.get(spaceId);
    if (!entry) {
      const url = new URL(`./${spaceId}.sqlite`, env.MEMORY_DIR);
      const space = openV2Space(url);
      entry = {
        space,
        subs: new SubscriptionManager(),
        clientSubs: new Map(),
      };
      this.spaces.set(spaceId, entry);
    }
    return entry;
  }

  /**
   * Resolve user operations (no parent field) into full operations
   * with parent references resolved from the current head state.
   */
  private resolveOperations(
    space: V2Space,
    branch: string,
    userOps: UserOperation[],
  ): Operation[] {
    return userOps.map((uop): Operation => {
      const head = space.readHead(branch, uop.id);
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

  /**
   * Apply a transaction to a space. Returns the commit on success or
   * a V2ConflictError on conflict.
   */
  transact(
    spaceId: string,
    args: TransactArgs,
  ): { ok: Commit } | { error: V2ConflictError } {
    const entry = this.getOrOpenSpace(spaceId);
    const branch = args.branch ?? "";

    // Convert wire-format confirmed reads to the ClientCommit format
    const confirmedReads = args.reads.confirmed.map((r) => ({
      id: r.id,
      hash: r.hash as unknown as Reference,
      version: r.version,
    }));
    const pendingReads = args.reads.pending.map((r) => ({
      id: r.id,
      hash: r.hash as unknown as Reference,
      fromCommit: r.fromCommit as unknown as Reference,
    }));

    // Resolve user operations to full operations with parent references
    const operations = this.resolveOperations(
      entry.space,
      branch,
      args.operations,
    );

    const clientCommit: ClientCommit = {
      reads: { confirmed: confirmedReads, pending: pendingReads },
      operations,
      branch: args.branch,
      codeCID: args.codeCID
        ? (args.codeCID as unknown as Reference)
        : undefined,
    };

    const result = applyCommit(entry.space.store, clientCommit);

    if ("ok" in result) {
      // Fan out subscription updates
      const updates = entry.subs.match(result.ok);
      for (const update of updates) {
        this.pushToSubscribers(spaceId, update.subscriptionId, update);
      }
    }

    return result;
  }

  /**
   * Execute a query against a space.
   */
  query(spaceId: string, args: QueryArgs): FactSet {
    const entry = this.getOrOpenSpace(spaceId);
    return executeSimpleQuery(entry.space, {
      select: args.select as Record<string, Record<string, unknown>>,
      since: args.since,
      branch: args.branch,
    });
  }

  /**
   * Register a subscription. Returns the initial state matching the
   * subscription's selector.
   */
  subscribe(
    spaceId: string,
    args: SubscribeArgs,
    ws: WebSocket,
  ): FactSet {
    const entry = this.getOrOpenSpace(spaceId);

    entry.subs.add({
      id: args.id,
      select: args.select,
      since: args.since ?? 0,
      branch: args.branch ?? "",
    });

    // Track which WebSocket owns this subscription
    let subIds = entry.clientSubs.get(ws);
    if (!subIds) {
      subIds = new Set();
      entry.clientSubs.set(ws, subIds);
    }
    subIds.add(args.id);

    return this.query(spaceId, {
      select: args.select,
      since: args.since,
      branch: args.branch,
    });
  }

  /**
   * Remove a subscription by its invocation ID.
   */
  unsubscribe(spaceId: string, subId: InvocationId): boolean {
    const entry = this.spaces.get(spaceId);
    if (!entry) return false;
    return entry.subs.remove(subId);
  }

  /**
   * Register a WebSocket client for a space.
   */
  registerClient(spaceId: string, ws: WebSocket): void {
    const entry = this.getOrOpenSpace(spaceId);
    if (!entry.clientSubs.has(ws)) {
      entry.clientSubs.set(ws, new Set());
    }
  }

  /**
   * Remove a WebSocket client and clean up its subscriptions.
   */
  removeClient(spaceId: string, ws: WebSocket): void {
    const entry = this.spaces.get(spaceId);
    if (!entry) return;

    const subIds = entry.clientSubs.get(ws);
    if (subIds) {
      for (const id of subIds) {
        entry.subs.remove(id);
      }
    }
    entry.clientSubs.delete(ws);
  }

  /**
   * Push a subscription update to all WebSocket clients that own the
   * given subscription ID.
   */
  private pushToSubscribers(
    spaceId: string,
    subscriptionId: InvocationId,
    update: { commit: Commit; revisions: unknown[] },
  ): void {
    const entry = this.spaces.get(spaceId);
    if (!entry) return;

    for (const [ws, subIds] of entry.clientSubs) {
      if (subIds.has(subscriptionId) && ws.readyState === WebSocket.OPEN) {
        const msg = JSON.stringify({
          the: "task/effect",
          of: subscriptionId,
          is: {
            commit: update.commit,
            revisions: update.revisions,
          },
        });
        ws.send(msg);
      }
    }
  }

  /**
   * Close all spaces and release resources.
   */
  close(): void {
    for (const entry of this.spaces.values()) {
      entry.space.close();
      entry.subs.clear();
      entry.clientSubs.clear();
    }
    this.spaces.clear();
  }
}

export const v2MemoryService = new V2MemoryService();
