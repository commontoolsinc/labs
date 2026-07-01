import { deepFreeze } from "@commonfabric/data-model/deep-freeze";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { CellScope } from "../builder/types.ts";

/**
 * The verified channel metadata a vouched ingest channel stamps onto a
 * transaction so the commit pipeline can mint an `ExternalIngest` provenance
 * mark on the durably-appended value. Every field is supplied by the trusted
 * operator-side ingest helper (`custodyIngest`) — NOT by the external
 * presenter's payload — which is what makes the mark honest: the mint derives
 * only from this metadata, touching zero attacker bytes (the split-mint).
 *
 * See docs/development/proposals/vouched-ingest-channel-mint-design.md.
 */
export type CfcExternalIngestMeta = {
  /** The ingest channel (its dedicated space DID). */
  readonly channel: string;
  /** The presenter the grant was vouched to (recorded, not enforced). */
  readonly audience: string;
  /** Operator wall-clock receive time (ISO 8601), captured before the write. */
  readonly receivedAt: string;
  /** Digest of the payload bytes the helper actually wrote. */
  readonly valueDigest: string;
  /**
   * The document + path the mark anchors to — the cell the ingest writes into.
   * Declared explicitly (rather than inferred from the write diff) so the mark
   * lands at the cell root for both a whole-object `set` and an element-wise
   * array append, where the diffed writes never touch the array path itself.
   */
  readonly target: {
    readonly space: MemorySpace;
    readonly id: URI;
    readonly scope: CellScope;
    readonly path: readonly string[];
  };
};

/**
 * Per-transaction external-ingest stamps. Deliberately a module-private
 * `WeakMap` keyed by the transaction — NOT a field on `CfcTxState` and NOT a
 * method on `IExtendedStorageTransaction`. The mint it drives is
 * builtin-authored and bypasses `gateRuntimeMintedIntegrity`, so exposing the
 * trigger on the public transaction surface would be a forge oracle: any
 * pattern/handler reaching `cell.tx` could stamp a trusted "arrived via channel
 * X" mark on its own writes. Keeping the channel module-private means only
 * trusted host code that can import this module (the operator-side
 * `custodyIngest` helper) can set it; sandboxed pattern code cannot.
 */
const ingestStamps = new WeakMap<
  IExtendedStorageTransaction,
  CfcExternalIngestMeta
>();

/**
 * Stamp a transaction as a vouched external ingest. Write-once per transaction
 * (a later call is ignored), and marks the transaction CFC-relevant so the
 * boundary commit runs and mints the mark even in an otherwise CFC-disabled
 * runtime (a fresh, unlabeled ingest doc would otherwise leave the tx
 * irrelevant and the mark would silently vanish).
 *
 * PRIVILEGED: only call from trusted operator-side ingest code. The stamp it
 * sets is honored unconditionally by the mint.
 */
export const stampExternalIngest = (
  tx: IExtendedStorageTransaction,
  meta: CfcExternalIngestMeta,
): void => {
  if (ingestStamps.has(tx)) return;
  ingestStamps.set(tx, deepFreeze({ ...meta, target: { ...meta.target } }));
  tx.markCfcRelevant("external-ingest");
};

/** The external-ingest stamp for this transaction, if any. */
export const externalIngestStamp = (
  tx: IExtendedStorageTransaction,
): CfcExternalIngestMeta | undefined => ingestStamps.get(tx);
