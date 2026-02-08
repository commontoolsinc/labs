/**
 * Memory v2 Provider Session
 *
 * Server-side session that processes client commands against a SpaceV2.
 * Handles transact, query, subscribe, and branch operations.
 * From spec §04.
 */

import type { SpaceV2 } from "./space.ts";
import { SubscriptionManager } from "./subscription.ts";
import type {
  ClientCommit,
  ConflictDetail,
  FactSet,
  Selector,
} from "./types.ts";
import { DEFAULT_BRANCH } from "./types.ts";
import type {
  Command,
  CreateBranchSuccess,
  InvocationId,
  ListBranchesSuccess,
  ProviderMessage,
  QueryResult,
  SubscriptionUpdate,
  TaskEffect,
  TaskReturn,
  TransactResult,
} from "./protocol.ts";

/**
 * A provider session wrapping a SpaceV2 storage engine.
 * Processes commands and manages subscriptions.
 */
export class ProviderSession {
  private space: SpaceV2;
  private subscriptions: SubscriptionManager;
  private responseQueue: ProviderMessage[] = [];
  private effectListeners: Set<(msg: ProviderMessage) => void> = new Set();

  constructor(space: SpaceV2) {
    this.space = space;
    this.subscriptions = new SubscriptionManager();
  }

  /**
   * Process a command and return the response.
   * For subscriptions, effects are delivered via the effect listener.
   */
  invoke(
    invocationId: InvocationId,
    command: Command,
  ): ProviderMessage {
    switch (command.cmd) {
      case "/memory/transact":
        return this.handleTransact(invocationId, command.args);
      case "/memory/query":
        return this.handleQuery(invocationId, command.args);
      case "/memory/query/subscribe":
        return this.handleSubscribe(
          invocationId,
          command.args,
        );
      case "/memory/query/unsubscribe":
        return this.handleUnsubscribe(invocationId, command.args);
      case "/memory/branch/create":
        return this.handleCreateBranch(invocationId, command.args);
      case "/memory/branch/delete":
        return this.handleDeleteBranch(invocationId, command.args);
      case "/memory/branch/list":
        return this.handleListBranches(invocationId);
      case "/memory/graph/query":
        return this.handleGraphQuery(invocationId, command.args);
      default:
        return {
          the: "task/return",
          of: invocationId,
          is: {
            error: { name: "QueryError" as const, message: "Unknown command" },
          },
        };
    }
  }

  /**
   * Register a listener for subscription effects (task/effect messages).
   */
  onEffect(listener: (msg: ProviderMessage) => void): () => void {
    this.effectListeners.add(listener);
    return () => this.effectListeners.delete(listener);
  }

  /**
   * Close the session and clean up subscriptions.
   */
  close(): void {
    this.subscriptions.clear();
    this.effectListeners.clear();
  }

  // ─── Command Handlers ───────────────────────────────────────────────────

  private handleTransact(
    invocationId: InvocationId,
    args: ClientCommit,
  ): TaskReturn<TransactResult> {
    try {
      const commit = this.space.commit(args);

      // Notify subscriptions about the new commit
      this.subscriptions.notify(commit);

      return {
        the: "task/return",
        of: invocationId,
        is: { ok: commit },
      };
    } catch (err) {
      const error = err as Error & {
        name: string;
        commit?: ClientCommit;
        conflicts?: ConflictDetail[];
      };
      if (error.name === "ConflictError") {
        return {
          the: "task/return",
          of: invocationId,
          is: {
            error: {
              name: "ConflictError",
              commit: error.commit ?? args,
              conflicts: error.conflicts ?? [],
            },
          },
        };
      }
      return {
        the: "task/return",
        of: invocationId,
        is: {
          error: { name: "TransactionError", message: error.message },
        },
      };
    }
  }

  private handleQuery(
    invocationId: InvocationId,
    args: { select: Selector; since?: number; branch?: string },
  ): TaskReturn<QueryResult> {
    try {
      const branch = args.branch ?? DEFAULT_BRANCH;
      const facts = this.space.query(args.select, branch);

      // Apply since filter
      const result: FactSet = {};
      for (const [id, entry] of Object.entries(facts)) {
        if (args.since !== undefined && entry.version <= args.since) continue;
        result[id] = entry;
      }

      return {
        the: "task/return",
        of: invocationId,
        is: { ok: result },
      };
    } catch (err) {
      return {
        the: "task/return",
        of: invocationId,
        is: {
          error: {
            name: "QueryError",
            message: (err as Error).message,
          },
        },
      };
    }
  }

  private handleSubscribe(
    invocationId: InvocationId,
    args: { select: Selector; since?: number; branch?: string },
  ): TaskReturn<QueryResult> {
    const branch = args.branch ?? DEFAULT_BRANCH;

    // Execute the initial query
    const facts = this.space.query(args.select, branch);
    const result: FactSet = {};
    let maxVersion = args.since ?? 0;

    for (const [id, entry] of Object.entries(facts)) {
      if (args.since !== undefined && entry.version <= args.since) continue;
      result[id] = entry;
      if (entry.version > maxVersion) maxVersion = entry.version;
    }

    // Register subscription for future updates
    this.subscriptions.subscribe(
      invocationId,
      args.select,
      branch,
      maxVersion,
      (update: SubscriptionUpdate) => {
        const effect: TaskEffect<SubscriptionUpdate> = {
          the: "task/effect",
          of: invocationId,
          is: update,
        };
        for (const listener of this.effectListeners) {
          listener(effect);
        }
      },
    );

    return {
      the: "task/return",
      of: invocationId,
      is: { ok: result },
    };
  }

  private handleUnsubscribe(
    invocationId: InvocationId,
    args: { source: InvocationId },
  ): TaskReturn<{ ok: Record<string, never> }> {
    this.subscriptions.unsubscribe(args.source);
    return {
      the: "task/return",
      of: invocationId,
      is: { ok: {} },
    };
  }

  private handleCreateBranch(
    invocationId: InvocationId,
    args: { name: string; fromBranch?: string; atVersion?: number },
  ): TaskReturn<CreateBranchSuccess> {
    const fromBranch = args.fromBranch ?? DEFAULT_BRANCH;
    this.space.createBranch(args.name, fromBranch);

    const branchInfo = this.space.getBranch(args.name)!;
    return {
      the: "task/return",
      of: invocationId,
      is: {
        ok: {
          name: args.name,
          forkedFrom: fromBranch,
          atVersion: branchInfo.fork_version ?? 0,
        },
      },
    };
  }

  private handleDeleteBranch(
    invocationId: InvocationId,
    args: { name: string },
  ): TaskReturn<{ ok: Record<string, never> }> {
    this.space.deleteBranch(args.name);
    return {
      the: "task/return",
      of: invocationId,
      is: { ok: {} },
    };
  }

  private handleListBranches(
    invocationId: InvocationId,
  ): TaskReturn<ListBranchesSuccess> {
    const branches = this.space.listBranches();
    return {
      the: "task/return",
      of: invocationId,
      is: {
        ok: {
          branches: branches.map((b) => ({
            name: b.name,
            headVersion: b.head_version,
            createdAt: b.created_at,
          })),
        },
      },
    };
  }

  private handleGraphQuery(
    invocationId: InvocationId,
    args: {
      selectSchema: Record<string, { path: readonly string[] }>;
      since?: number;
      subscribe?: boolean;
      excludeSent?: boolean;
      branch?: string;
    },
  ): TaskReturn<QueryResult> {
    // Graph queries are a superset of simple queries.
    // For now, treat root entities as simple selector matches
    // and return their values. Schema traversal will be added
    // when the runner integration needs it.
    const branch = args.branch ?? DEFAULT_BRANCH;
    const selector: Selector = {};
    for (const key of Object.keys(args.selectSchema)) {
      selector[key] = {};
    }

    const facts = this.space.query(selector, branch);
    const result: FactSet = {};

    for (const [id, entry] of Object.entries(facts)) {
      if (args.since !== undefined && entry.version <= args.since) continue;
      result[id] = entry;
    }

    // If subscribe requested, register a subscription
    if (args.subscribe) {
      let maxVersion = args.since ?? 0;
      for (const entry of Object.values(result)) {
        if (entry.version > maxVersion) maxVersion = entry.version;
      }

      this.subscriptions.subscribe(
        invocationId,
        selector,
        branch,
        maxVersion,
        (update: SubscriptionUpdate) => {
          const effect: TaskEffect<SubscriptionUpdate> = {
            the: "task/effect",
            of: invocationId,
            is: update,
          };
          for (const listener of this.effectListeners) {
            listener(effect);
          }
        },
      );
    }

    return {
      the: "task/return",
      of: invocationId,
      is: { ok: result },
    };
  }
}
