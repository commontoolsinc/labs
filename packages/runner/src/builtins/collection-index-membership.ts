/** Maintains one occurrence's index membership in the caller's transaction. */

import { hashStringOf } from "@commonfabric/data-model";
import { utf8Compare } from "@commonfabric/utils/utf8";

import { type Cell, recordRelevantSchemaWritePolicyInput } from "../cell.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import { snapshotQueryResult } from "../query-result-proxy.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import {
  allowMutableTransactionRead,
  ignoreReadForScheduling,
  machineryRead,
  markReadAsAttemptedWrite,
} from "../storage/reactivity-log.ts";
import {
  collectionKeyBucket,
  type CollectionKeyIdentity,
  type ResolvedCollectionKey,
} from "./collection-index-key.ts";

/** Original source occurrence retained as address data. */
interface IndexMember {
  /** Existing collection occurrence identity used for deterministic ordering. */
  occurrence: string;

  /** Original source address, including its scope. */
  element: NormalizedFullLink;
}

/** Occupied key with enough address data to publish its public representation. */
interface OccupiedKey {
  /** Typed routing identity. */
  identity: CollectionKeyIdentity;

  /** Resolved address for Cell keys. */
  cell?: NormalizedFullLink;
}

/** Current bucket and source occurrence needed to reconcile durable removals. */
interface IndexAssignment {
  /** Internal typed-key bucket address. */
  bucket: string;

  /** Original collection occurrence identity. */
  occurrence: string;
}

/** Durable maintenance records belonging to one scoped index instance. */
export interface CollectionIndexMembership {
  /** Current bucket of each occurrence, addressed by canonical occurrence hash. */
  assignments: Record<string, IndexAssignment | undefined>;

  /** Members of each bucket, independently addressed from other buckets. */
  members: Record<string, Record<string, IndexMember> | undefined>;

  /** Occupied key metadata used by demanded enumeration. */
  occupied: Record<string, OccupiedKey | undefined>;
}

/** Public index descriptor whose groups preserve original source links. */
export interface MaintainedCollectionIndex {
  /** Descriptor recognized by Cell lookup. */
  kind: "collection-index";

  /** Empty-result and duplicate-selection behavior. */
  mode: "group" | "key";

  /** Occupied keys in deterministic typed order. */
  keys: unknown[];

  /** Independently published bucket values. */
  buckets: Record<string, unknown>;
}

/** Deletes one owned slot without following its stored source reference. */
function deleteIndexSlot(
  tx: IExtendedStorageTransaction,
  cell: Cell<unknown>,
): void {
  const link = cell.getAsNormalizedFullLink();
  tx.readValueOrThrow(link, {
    meta: { ...markReadAsAttemptedWrite, ...allowMutableTransactionRead },
  });
  recordRelevantSchemaWritePolicyInput(tx, link, link.schema ?? cell.schema);
  tx.writeValueOrThrow(link, undefined, { delete: true });
  tx.poisonMergeableOp?.(link);
}

/**
 * Moves or removes one source occurrence and publishes its affected buckets.
 * The owning coordinator supplies runtime-owned cells in the index's scope.
 * Maintenance reads participate in transaction conflict checks but do not make
 * other members' writes reactive inputs of this occurrence's key extractor.
 */
export function maintainCollectionIndexMembership(
  tx: IExtendedStorageTransaction,
  state: Cell<CollectionIndexMembership>,
  index: Cell<MaintainedCollectionIndex>,
  mode: "group" | "key",
  occurrence: string,
  key: ResolvedCollectionKey | undefined,
  element: Cell<unknown>,
): void {
  const runtime = index.runtime;
  const stored = state.withTx(tx);
  const output = index.withTx(tx);
  const memberId = hashStringOf(occurrence);
  const next = key ? collectionKeyBucket(key.identity) : undefined;
  tx.runWithAmbientReadMeta(
    { ...ignoreReadForScheduling, ...machineryRead },
    () => {
      const previous = stored.key("assignments").key(memberId).get()?.bucket;
      const affected = new Set([previous, next]);
      for (const bucket of affected) {
        if (bucket === undefined) continue;
        const membersCell = stored.key("members").key(bucket);
        const members = { ...snapshotQueryResult(membersCell.get() ?? {}) };
        const wasOccupied = Object.keys(members).length > 0;
        if (bucket === next) {
          members[memberId] = {
            occurrence,
            element: element.getAsNormalizedFullLink(),
          };
        } else {
          delete members[memberId];
        }
        const ordered = Object.values(members).sort((a, b) =>
          utf8Compare(a.occurrence, b.occurrence)
        );
        if (ordered.length) membersCell.set(members);
        else deleteIndexSlot(tx, membersCell);
        const values = ordered.map((member) =>
          runtime.getCellFromLink(member.element, undefined, tx)
        );
        if (ordered.length) {
          output.key("buckets").key(bucket).set(
            mode === "group" ? values : values[0],
          );
        } else {
          deleteIndexSlot(tx, output.key("buckets").key(bucket));
        }
        if (wasOccupied !== (ordered.length > 0)) {
          if (ordered.length) {
            stored.key("occupied").key(bucket).set({
              identity: key!.identity,
              ...(key!.identity.kind === "cell"
                ? {
                  cell: (key!.key as Cell<unknown>).getAsNormalizedFullLink(),
                }
                : {}),
            });
          } else {
            deleteIndexSlot(tx, stored.key("occupied").key(bucket));
          }
        }
      }
      if (next === undefined) {
        deleteIndexSlot(tx, stored.key("assignments").key(memberId));
      } else {
        stored.key("assignments").key(memberId).set({
          bucket: next,
          occurrence,
        });
      }
    },
  );
}
