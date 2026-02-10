/**
 * V2 Storage Transaction
 *
 * Provides a v2-native transaction model that works with V2Replica.
 * Tracks read dependencies automatically and queues write operations.
 * On commit, builds a ClientCommit and delegates to the replica.
 *
 * This is a standalone v2 transaction -- it does not implement the
 * v1 IStorageTransaction interface. The bridge between v1 and v2
 * transaction interfaces will be added when wiring into Runtime.edit().
 *
 * @see spec 03-commit-model.md §3.2
 * @module v2-transaction
 */

import type {
  ConfirmedRead,
  EntityId,
  JSONValue,
  Operation,
  PatchOp,
  PendingRead,
} from "@commontools/memory/v2-types";
import type { Reference } from "merkle-reference";
import { fromString } from "@commontools/memory/reference";
import { EMPTY } from "@commontools/memory/v2-reference";
import { deleteOp, patchOp, setOp } from "@commontools/memory/v2-fact";
import { type V2Changes, V2Replica } from "./v2-replica.ts";

// ---------------------------------------------------------------------------
// Transaction status
// ---------------------------------------------------------------------------

export type V2TransactionStatus = "ready" | "committed" | "aborted";

// ---------------------------------------------------------------------------
// V2Transaction
// ---------------------------------------------------------------------------

export class V2Transaction {
  readonly replica: V2Replica;
  private _status: V2TransactionStatus = "ready";

  /** Tracked confirmed read dependencies (entity → read). */
  private confirmedReadMap = new Map<EntityId, ConfirmedRead>();

  /** Tracked pending read dependencies (entity → read). */
  private pendingReadMap = new Map<EntityId, PendingRead>();

  /** Queued operations in order. */
  private ops: Operation[] = [];

  /** Local write buffer for read-your-writes within the transaction. */
  private localWrites = new Map<EntityId, { value?: JSONValue }>();

  constructor(replica: V2Replica) {
    this.replica = replica;
  }

  get status(): V2TransactionStatus {
    return this._status;
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  /**
   * Read an entity's current value. Checks local writes first (read-your-writes),
   * then falls through to the replica. Automatically tracks the read as a
   * dependency for the eventual commit.
   */
  read(entityId: EntityId): JSONValue | undefined {
    this.assertReady();

    // Read-your-writes: check local buffer first
    if (this.localWrites.has(entityId)) {
      return this.localWrites.get(entityId)!.value;
    }

    // Read from replica
    const result = this.replica.get(entityId);
    if (!result) return undefined;

    // Track as read dependency (only first read per entity is tracked)
    if (result.source === "confirmed") {
      if (!this.confirmedReadMap.has(entityId)) {
        const entry = this.replica.state.confirmed.get(entityId);
        if (entry) {
          this.confirmedReadMap.set(entityId, {
            id: entityId,
            hash: fromString(entry.hash) as unknown as Reference,
            version: entry.version,
          });
        }
      }
    } else if (result.source === "pending") {
      if (!this.pendingReadMap.has(entityId)) {
        const pending = this.replica.state.pending.get(entityId);
        if (pending) {
          this.pendingReadMap.set(entityId, {
            id: entityId,
            hash: fromString(pending.hash) as unknown as Reference,
            fromCommit: fromString(
              pending.fromCommit,
            ) as unknown as Reference,
          });
        }
      }
    }

    return result.value;
  }

  // -------------------------------------------------------------------------
  // Write operations
  // -------------------------------------------------------------------------

  /**
   * Queue a set operation (full replacement).
   */
  set(entityId: EntityId, value: JSONValue): void {
    this.assertReady();
    const parent = this.resolveParent(entityId);
    this.ops.push(setOp(entityId, value, parent));
    this.localWrites.set(entityId, { value });
  }

  /**
   * Queue a patch operation (incremental change).
   */
  patch(entityId: EntityId, patches: PatchOp[]): void {
    this.assertReady();
    const parent = this.resolveParent(entityId);
    this.ops.push(patchOp(entityId, patches, parent));
    // Patches don't have a fully resolved local value,
    // so we clear the local write buffer for this entity.
    this.localWrites.delete(entityId);
  }

  /**
   * Queue a delete operation.
   */
  delete(entityId: EntityId): void {
    this.assertReady();
    const parent = this.resolveParent(entityId);
    this.ops.push(deleteOp(entityId, parent));
    this.localWrites.set(entityId, { value: undefined });
  }

  // -------------------------------------------------------------------------
  // Commit / Abort
  // -------------------------------------------------------------------------

  /**
   * Commit the transaction: builds a ClientCommit from tracked reads
   * and queued operations, then applies it to the replica.
   *
   * Returns the commit hash and entity-level change notifications.
   */
  commit(): { commitHash: string; changes: V2Changes } {
    this.assertReady();
    this._status = "committed";

    const confirmedReads = Array.from(this.confirmedReadMap.values());
    const pendingReads = Array.from(this.pendingReadMap.values());

    return this.replica.commit(this.ops, confirmedReads, pendingReads);
  }

  /**
   * Abort the transaction. No operations will be applied.
   */
  abort(): void {
    this.assertReady();
    this._status = "aborted";
  }

  /**
   * Get the queued operations (for inspection/testing).
   */
  get operations(): readonly Operation[] {
    return this.ops;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Resolve the parent reference for an entity. Uses the replica's
   * current state to find the latest fact hash.
   */
  private resolveParent(entityId: EntityId): Reference {
    // Check confirmed state first
    const confirmed = this.replica.state.confirmed.get(entityId);
    if (confirmed) {
      return fromString(confirmed.hash) as unknown as Reference;
    }

    // Check pending state
    const pending = this.replica.state.pending.get(entityId);
    if (pending) {
      return fromString(pending.hash) as unknown as Reference;
    }

    // New entity — use empty reference
    return EMPTY(entityId);
  }

  private assertReady(): void {
    if (this._status !== "ready") {
      throw new Error(`Transaction is ${this._status}`);
    }
  }
}
