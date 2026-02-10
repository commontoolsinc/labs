/**
 * Two-tier client state for Memory v2.
 *
 * Confirmed: server-acknowledged facts with real version numbers.
 * Pending: optimistic local writes that may be rejected.
 *
 * @see spec 03-commit-model.md SS3.3
 * @module v2-client-state
 */

import type {
  ConfirmedRead,
  EntityId,
  JSONValue,
  Operation,
  PendingRead,
} from "@commontools/memory/v2-types";

// Re-export for convenience
export type { EntityId, JSONValue };

/**
 * A confirmed entity entry -- server-acknowledged.
 */
export interface ConfirmedEntry {
  version: number;
  hash: string; // Reference as string
  value?: JSONValue; // undefined means entity was deleted or never written
}

/**
 * A pending commit -- optimistic local write.
 */
export interface PendingCommit {
  /** Provisional hash of this commit (computed locally). */
  hash: string;

  /** Operations in this commit. */
  operations: Operation[];

  /** Read dependencies. */
  reads: {
    confirmed: ConfirmedRead[];
    pending: PendingRead[];
  };

  /** Computed values for entities written in this commit. */
  writes: Map<EntityId, { value?: JSONValue; hash: string }>;
}

/**
 * Confirmed state -- server-acknowledged entity values.
 */
export class ConfirmedState {
  private entries = new Map<EntityId, ConfirmedEntry>();

  get(id: EntityId): ConfirmedEntry | undefined {
    return this.entries.get(id);
  }

  set(id: EntityId, entry: ConfirmedEntry): void {
    this.entries.set(id, entry);
  }

  delete(id: EntityId): void {
    this.entries.delete(id);
  }

  has(id: EntityId): boolean {
    return this.entries.has(id);
  }

  getAll(): ReadonlyMap<EntityId, ConfirmedEntry> {
    return this.entries;
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * Pending state -- ordered queue of unconfirmed commits.
 */
export class PendingState {
  private queue: PendingCommit[] = [];

  /** Add a commit to the end of the pending queue. */
  push(commit: PendingCommit): void {
    this.queue.push(commit);
  }

  /** Get the current value of an entity from pending commits (newest first). */
  get(
    entityId: EntityId,
  ): { value?: JSONValue; hash: string; fromCommit: string } | undefined {
    // Search from newest to oldest
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const commit = this.queue[i];
      const write = commit.writes.get(entityId);
      if (write) {
        return { ...write, fromCommit: commit.hash };
      }
    }
    return undefined;
  }

  /** Find a pending commit by its hash. */
  find(commitHash: string): PendingCommit | undefined {
    return this.queue.find((c) => c.hash === commitHash);
  }

  /**
   * Remove a confirmed commit from the queue.
   * Returns the removed commit, or undefined if not found.
   */
  remove(commitHash: string): PendingCommit | undefined {
    const idx = this.queue.findIndex((c) => c.hash === commitHash);
    if (idx === -1) return undefined;
    return this.queue.splice(idx, 1)[0];
  }

  /**
   * Reject a commit and cascade-reject all commits that depend on it.
   * Returns all rejected commits (including cascaded ones).
   */
  reject(commitHash: string): PendingCommit[] {
    const rejected: PendingCommit[] = [];
    const rejectedHashes = new Set<string>();

    // Find the initial commit to reject
    const idx = this.queue.findIndex((c) => c.hash === commitHash);
    if (idx === -1) return rejected;

    // Mark for rejection
    rejectedHashes.add(commitHash);

    // Cascade: any commit that has a pending read from a rejected commit
    // must also be rejected
    let changed = true;
    while (changed) {
      changed = false;
      for (const commit of this.queue) {
        if (rejectedHashes.has(commit.hash)) continue;
        for (const read of commit.reads.pending) {
          if (rejectedHashes.has(read.fromCommit.toString())) {
            rejectedHashes.add(commit.hash);
            changed = true;
            break;
          }
        }
      }
    }

    // Remove all rejected commits from queue
    this.queue = this.queue.filter((c) => {
      if (rejectedHashes.has(c.hash)) {
        rejected.push(c);
        return false;
      }
      return true;
    });

    return rejected;
  }

  /** Get all pending commits in order. */
  getAll(): readonly PendingCommit[] {
    return this.queue;
  }

  /** Number of pending commits. */
  get length(): number {
    return this.queue.length;
  }

  /** Clear all pending commits. */
  clear(): void {
    this.queue = [];
  }
}

/**
 * Combined client state with two-tier read resolution.
 * Reads check pending first (newest wins), then confirmed.
 */
export class ClientState {
  readonly confirmed = new ConfirmedState();
  readonly pending = new PendingState();

  /**
   * Read an entity's current value.
   * Checks pending commits first (newest wins), then confirmed state.
   */
  read(
    entityId: EntityId,
  ): { value?: JSONValue; source: "pending" | "confirmed" } | undefined {
    // Check pending first (most recent commit wins)
    const pendingValue = this.pending.get(entityId);
    if (pendingValue) {
      return { value: pendingValue.value, source: "pending" };
    }

    // Fall back to confirmed
    const confirmedEntry = this.confirmed.get(entityId);
    if (confirmedEntry) {
      return { value: confirmedEntry.value, source: "confirmed" };
    }

    return undefined;
  }

  /**
   * Confirm a pending commit -- promote its writes to confirmed state.
   */
  confirm(
    commitHash: string,
    serverVersion: number,
  ): PendingCommit | undefined {
    const commit = this.pending.remove(commitHash);
    if (!commit) return undefined;

    // Promote all writes to confirmed state
    for (const [entityId, write] of commit.writes) {
      this.confirmed.set(entityId, {
        version: serverVersion,
        hash: write.hash,
        value: write.value,
      });
    }

    return commit;
  }

  /**
   * Reject a pending commit -- discard it and cascade-reject dependents.
   * Returns all rejected commits.
   */
  reject(commitHash: string): PendingCommit[] {
    return this.pending.reject(commitHash);
  }

  /** Clear all state. */
  clear(): void {
    this.confirmed.clear();
    this.pending.clear();
  }
}
