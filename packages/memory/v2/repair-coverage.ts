/**
 * Transaction-owned document coverage for server synchronization. Repair
 * delivery composes with graph frames while keeping ownership and wake keys
 * separate from graph watches and execution demand.
 */

import {
  type CellScope,
  type ClientCommit,
  type CommitRepairAddress,
  type CommitRepairFailure,
  type CommitRepairReceipt,
  type CommitRepairVersion,
  type EntitySnapshot,
  ProtocolError,
  resolveScopeKey,
  type ScopeKeyIdentity,
  type SessionSync,
  type SessionSyncRemove,
  type SessionSyncUpsert,
} from "../v2.ts";
import { type DocumentSnapshotReader, SchemaClosureError } from "./query.ts";
import {
  cacheKeyForEntity,
  compareSyncAddress,
  sameSnapshot,
  type SessionCacheEntry,
  toCacheEntry,
  toWireRemove,
  toWireUpsert,
  trackedIdsFromEntries,
} from "./server-sync.ts";
import { getCommitRepairFootprint } from "./transaction-repair.ts";

/**
 * A complete frame whose repair bookkeeping is still staged. Commit after
 * successful delivery under the session's publication lock; discard on failure.
 */
export type PreparedRepairSync = {
  readonly sync: SessionSync;
  commit(): void;
};

type Repair = {
  readonly documents: CommitRepairAddress[];
  readonly retryAfterSeq: number;
  pending: boolean;
};

/**
 * Coverage belonging to one authenticated logical session. The caller owns
 * authorization, publication ordering, reconnect restoration, and destruction
 * on identity change. Ordinary watch mutations never replace this ownership.
 */
export class RepairCoverage {
  readonly #space: string;
  readonly #identity: ScopeKeyIdentity;
  readonly #repairs = new Map<number, Repair>();
  #delivered = new Map<string, SessionCacheEntry>();
  #wakeKeys = new Set<string>();
  #generation = 0;
  #ownershipChanged = false;

  constructor(space: string, identity: ScopeKeyIdentity) {
    this.#space = space;
    this.#identity = { ...identity };
  }

  /** Number of rejected operations still owning document coverage. */
  get size(): number {
    return this.#repairs.size;
  }

  /**
   * Stages complete delivery for a rejection, including replay of one already
   * delivered. Reusing a local sequence for different dependencies is invalid.
   */
  register(commit: ClientCommit, retryAfterSeq: number): void {
    if (
      !Number.isSafeInteger(commit.localSeq) || commit.localSeq < 0 ||
      !Number.isSafeInteger(retryAfterSeq) || retryAfterSeq < 0
    ) {
      throw new ProtocolError("Invalid transaction repair sequence");
    }
    const documents = getCommitRepairFootprint(commit);
    const existing = this.#repairs.get(commit.localSeq);
    if (
      existing !== undefined && !sameAddresses(existing.documents, documents)
    ) {
      throw new ProtocolError(
        "Transaction repair replay changed its dependencies",
      );
    }
    this.#repairs.set(commit.localSeq, {
      documents,
      retryAfterSeq: Math.max(existing?.retryAfterSeq ?? 0, retryAfterSeq),
      pending: true,
    });
    this.#generation++;
    this.#ownershipChanged = true;
  }

  /** Releases one owner idempotently; delivery is retracted by the next frame. */
  release(localSeq: number): void {
    if (this.#repairs.delete(localSeq)) {
      this.#generation++;
      this.#ownershipChanged = true;
    }
  }

  /** Whether a pass owes receipts, release cleanup, or changed covered bases. */
  needsSync(dirtyIds?: ReadonlySet<string>): boolean {
    if (this.#ownershipChanged) return true;
    if (this.#repairs.size === 0) return this.#delivered.size > 0;
    if (dirtyIds === undefined) return true;
    for (const repair of this.#repairs.values()) {
      if (repair.pending) return true;
    }
    for (const id of dirtyIds) {
      if (this.#wakeKeys.has(id)) return true;
    }
    return false;
  }

  /**
   * Composes a graph frame with raw repair bases at the same server cut.
   * `graphEntries` is graph provenance only and is never mutated. Complete
   * receipts force all required snapshots into their first delivery, even if
   * the graph cache remembers sending them. Shared addresses appear once.
   */
  prepare(
    reader: DocumentSnapshotReader,
    graphSync: SessionSync,
    graphEntries: ReadonlyMap<string, SessionCacheEntry>,
    keyed = false,
  ): PreparedRepairSync {
    if (
      reader.space !== this.#space ||
      reader.identity.principal !== this.#identity.principal ||
      reader.identity.sessionId !== this.#identity.sessionId
    ) {
      throw new ProtocolError(
        "Repair reader belongs to a different logical session",
      );
    }
    if (reader.atSeq !== graphSync.toSeq) {
      throw new ProtocolError(
        "Repair and graph snapshots require the same server cut",
      );
    }
    const generation = this.#generation;
    const next = new Map<string, SessionCacheEntry>();
    const forced = new Set<string>();
    const receipts: CommitRepairReceipt[] = [];
    const failures: CommitRepairFailure[] = [];
    const entriesFor = (
      snapshots: readonly EntitySnapshot[],
    ) => snapshots.map((snapshot) => toCacheEntry(snapshot, this.#identity));

    for (const [localSeq, repair] of this.#repairs) {
      if (reader.atSeq < repair.retryAfterSeq) {
        throw new ProtocolError("Repair snapshot predates its rejection");
      }
      if (repair.documents.length === 0) {
        failures.push({ localSeq, reason: "unsupported-dependency" });
        continue;
      }
      try {
        const batch = reader.read(repair.documents);
        const documents = entriesFor(batch.documents);
        const schemas = entriesFor(batch.schemas);
        for (const entry of [...documents, ...schemas]) {
          const key = cacheKeyForEntity(entry.branch, entry.id, entry.scopeKey);
          next.set(key, entry);
          if (repair.pending) forced.add(key);
        }
        if (repair.pending) {
          receipts.push({
            localSeq,
            atSeq: reader.atSeq,
            documents: documents.map(versionOf),
            schemas: schemas.map(versionOf),
          });
        }
      } catch (error) {
        if (error instanceof SchemaClosureError) {
          failures.push({ localSeq, reason: "invalid-schema" });
        } else if (error instanceof ProtocolError) {
          failures.push({ localSeq, reason: "unresolvable-address" });
        } else {
          throw error;
        }
      }
    }

    const upserts = new Map<string, SessionSyncUpsert>();
    const removes = new Map<string, SessionSyncRemove>();
    for (const upsert of graphSync.upserts) {
      upserts.set(this.#wireKey(upsert), upsert);
    }
    for (const remove of graphSync.removes) {
      const key = this.#wireKey(remove);
      if (!next.has(key)) removes.set(key, remove);
    }
    for (const [key, entry] of next) {
      const graphUpsert = upserts.get(key);
      if (graphUpsert !== undefined && graphUpsert.seq > entry.seq) {
        throw new ProtocolError(
          "Graph delivery is newer than the repair snapshot",
        );
      }
      if (
        forced.has(key) || !sameSnapshot(this.#delivered.get(key), entry) ||
        graphUpsert !== undefined
      ) {
        upserts.set(key, toWireUpsert(entry, keyed));
      }
    }
    for (const [key, entry] of this.#delivered) {
      if (!next.has(key) && !graphEntries.has(key)) {
        removes.set(key, toWireRemove(entry, keyed));
      }
    }
    for (const key of upserts.keys()) removes.delete(key);
    const sync: SessionSync = {
      ...graphSync,
      upserts: [...upserts.values()].sort(compareSyncAddress),
      removes: [...removes.values()].sort(compareSyncAddress),
      ...(receipts.length === 0 ? {} : { repairs: receipts }),
      ...(failures.length === 0 ? {} : { repairFailures: failures }),
    };
    let committed = false;
    return {
      sync,
      commit: () => {
        if (committed) return;
        if (generation !== this.#generation) {
          throw new ProtocolError(
            "Repair ownership changed during frame delivery",
          );
        }
        this.#delivered = next;
        this.#wakeKeys = trackedIdsFromEntries(next.values());
        for (const receipt of receipts) {
          this.#repairs.get(receipt.localSeq)!.pending = false;
        }
        for (const failure of failures) this.#repairs.delete(failure.localSeq);
        this.#generation++;
        this.#ownershipChanged = false;
        committed = true;
      },
    };
  }

  #wireKey(address: SessionSyncRemove): string {
    return cacheKeyForEntity(
      address.branch,
      address.id,
      address.scopeKey ?? resolveScopeKey(address.scope, this.#identity),
    );
  }
}

/** Document version requirements use the recipient's scope vocabulary. */
function versionOf(entry: SessionCacheEntry): CommitRepairVersion {
  return {
    branch: entry.branch,
    id: entry.id,
    scope: entry.scope,
    seq: entry.seq,
    ...(entry.deleted === true ? { deleted: true } : {}),
  };
}

/** Replay identity is set membership, independent of transaction read order. */
function sameAddresses(
  left: readonly CommitRepairAddress[],
  right: readonly CommitRepairAddress[],
): boolean {
  if (left.length !== right.length) return false;
  const keys = new Map<string, Map<CellScope, Set<string>>>();
  for (const address of left) {
    let branch = keys.get(address.branch);
    if (branch === undefined) {
      branch = new Map();
      keys.set(address.branch, branch);
    }
    let ids = branch.get(address.scope);
    if (ids === undefined) {
      ids = new Set();
      branch.set(address.scope, ids);
    }
    ids.add(address.id);
  }
  return right.every((address) =>
    keys.get(address.branch)?.get(address.scope)?.has(address.id)
  );
}
