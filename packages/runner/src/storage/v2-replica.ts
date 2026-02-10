/**
 * V2 Replica - Client-side state management for a single v2 space.
 *
 * Manages the two-tier state (confirmed + pending) and provides
 * commit/integrate/confirm/reject operations that map to the
 * IMergedChanges notification interface for the scheduler.
 *
 * @see spec 03-commit-model.md §3.3
 * @module v2-replica
 */

import type {
  ClientCommit,
  Commit,
  ConfirmedRead,
  EntityId,
  JSONValue,
  Operation,
  PendingRead,
  SpaceId,
} from "@commontools/memory/v2-types";
import { computeCommitHash } from "@commontools/memory/v2-reference";
import { ClientState, type PendingCommit } from "./v2-client-state.ts";

// ---------------------------------------------------------------------------
// Change notification (maps to IMergedChanges for scheduler)
// ---------------------------------------------------------------------------

/**
 * Entity-level change notification.
 * Before/after values allow the scheduler to determine which cells need
 * re-evaluation.
 */
export interface EntityChange {
  id: EntityId;
  before?: JSONValue;
  after?: JSONValue;
}

/**
 * Collected changes from a commit or integration event.
 * This is the v2 equivalent of IMergedChanges.
 */
export interface V2Changes {
  /** Which entities changed. */
  changes: EntityChange[];
  /** Version number (0 for pending commits). */
  version: number;
}

// ---------------------------------------------------------------------------
// V2Replica
// ---------------------------------------------------------------------------

export class V2Replica {
  readonly spaceId: SpaceId;
  readonly state = new ClientState();

  /** Current branch name (empty string = default branch). */
  private _branch = "";

  constructor(spaceId: SpaceId) {
    this.spaceId = spaceId;
  }

  /** Get the current branch. */
  get branch(): string {
    return this._branch;
  }

  /**
   * Switch the replica to a different branch.
   * Clears all pending state (pending commits are branch-specific).
   */
  switchBranch(branch: string): void {
    if (branch === this._branch) return;
    this._branch = branch;
    // Pending commits are branch-specific; clear them on switch.
    // Confirmed state is also branch-specific, so clear everything.
    this.state.clear();
  }

  /**
   * Read the current value of an entity.
   * Checks pending first (newest wins), then confirmed.
   */
  get(
    entityId: EntityId,
  ): { value?: JSONValue; source: "pending" | "confirmed" } | undefined {
    return this.state.read(entityId);
  }

  /**
   * Create a pending commit from operations and read dependencies.
   * Returns the commit hash and the changes for notification.
   */
  commit(
    operations: Operation[],
    confirmedReads: ConfirmedRead[],
    pendingReads: PendingRead[] = [],
  ): { commitHash: string; changes: V2Changes } {
    // Build the client commit
    const clientCommit: ClientCommit = {
      reads: {
        confirmed: confirmedReads,
        pending: pendingReads,
      },
      operations,
    };

    const commitHash = computeCommitHash(clientCommit).toString();

    // Compute write values for each operation
    const writes = new Map<EntityId, { value?: JSONValue; hash: string }>();
    const entityChanges: EntityChange[] = [];

    for (const op of operations) {
      const before = this.state.read(op.id)?.value;

      switch (op.op) {
        case "set": {
          writes.set(op.id, { value: op.value, hash: commitHash });
          entityChanges.push({ id: op.id, before, after: op.value });
          break;
        }
        case "delete": {
          writes.set(op.id, { hash: commitHash });
          entityChanges.push({ id: op.id, before, after: undefined });
          break;
        }
        case "patch": {
          // For patches, we don't have the full resolved value locally.
          // The real value will come from the server confirmation.
          writes.set(op.id, { hash: commitHash });
          entityChanges.push({ id: op.id, before, after: undefined });
          break;
        }
        case "claim": {
          // Claims don't produce writes
          break;
        }
      }
    }

    // Add to pending queue
    const pendingCommit: PendingCommit = {
      hash: commitHash,
      operations,
      reads: clientCommit.reads,
      writes,
    };

    this.state.pending.push(pendingCommit);

    return {
      commitHash,
      changes: {
        changes: entityChanges,
        version: 0, // Pending commits have no server version yet
      },
    };
  }

  /**
   * Confirm a pending commit with the server's assigned version.
   * Promotes pending writes to confirmed state.
   * Returns changes for notification.
   */
  confirm(
    commitHash: string,
    serverVersion: number,
  ): V2Changes | undefined {
    const commit = this.state.confirm(commitHash, serverVersion);
    if (!commit) return undefined;

    const changes: EntityChange[] = [];
    for (const [entityId, write] of commit.writes) {
      changes.push({
        id: entityId,
        before: write.value, // Same value, promoted to confirmed
        after: write.value,
      });
    }

    return { changes, version: serverVersion };
  }

  /**
   * Reject a pending commit. Cascades to dependent commits.
   * Returns changes for notification (revert to confirmed values).
   */
  reject(commitHash: string): V2Changes {
    const rejected = this.state.reject(commitHash);
    const changes: EntityChange[] = [];

    for (const commit of rejected) {
      for (const [entityId, write] of commit.writes) {
        const confirmed = this.state.confirmed.get(entityId);
        changes.push({
          id: entityId,
          before: write.value,
          after: confirmed?.value,
        });
      }
    }

    return { changes, version: 0 };
  }

  /**
   * Integrate a server-pushed commit (from another client).
   * Updates confirmed state and returns changes for notification.
   */
  integrate(
    serverCommit: Commit,
    entityValues: Map<EntityId, JSONValue | undefined>,
  ): V2Changes {
    const changes: EntityChange[] = [];

    for (const [entityId, value] of entityValues) {
      const before = this.state.confirmed.get(entityId)?.value;
      this.state.confirmed.set(entityId, {
        version: serverCommit.version,
        hash: serverCommit.hash.toString(),
        value,
      });
      changes.push({ id: entityId, before, after: value });
    }

    return { changes, version: serverCommit.version };
  }

  /**
   * Clear all state (for reconnection scenarios).
   */
  clear(): void {
    this.state.clear();
  }
}
