/**
 * The per-space estimate of how much a replica's documents weigh, for the
 * sizes read that tells which spaces carry a worker's working set. Measuring
 * a document walks it, so the estimate is built across reads: each read
 * measures documents until a node budget shared by every space is spent,
 * remembers each measurement for as long as the measured value lives, and
 * reports how far it has got. A read on a quiet replica soon costs nothing
 * but cache lookups, and a document a frame replaces is measured again at
 * the next read with budget to spare.
 */

import type { MemorySpace } from "@commonfabric/memory/interface";
import type { EntityDocument } from "@commonfabric/memory/v2";
import { approximateJsonSize } from "@commonfabric/utils/approximate-json-size";

/** One space's share of the documents a storage manager holds. */
export type SpaceDocumentSizes = {
  space: MemorySpace;

  /** Documents the space's replica holds, absent ones included. */
  documents: number;

  /** Documents watched on the space's session. */
  watched: number;

  /**
   * Documents whose confirmed value has been measured, or that have none.
   * Equal to `documents` once the estimate has caught up with the replica.
   */
  measuredDocuments: number;

  /**
   * The approximate JSON length of the space's confirmed documents, as
   * `approximateJsonSize()` measures one, extrapolated from the measured
   * documents to all of them while some are still unmeasured. The pending
   * layers over a document, the materialized views cached beside it and the
   * cells built over it are not in the number, and neither is the heap's
   * own per-object overhead; what it ranks is the stored content each space
   * keeps decoded in this process.
   */
  approxBytes: number;
};

/**
 * Nodes the document measurement may visit in one sizes read, across every
 * space. The walk visits about a hundred thousand nodes a millisecond, so a
 * read spends at most about ten milliseconds measuring, and a replica whose
 * documents outrun the budget is measured across several reads.
 */
export const DOCUMENT_SIZE_NODE_BUDGET = 1_000_000;

/** The nodes one sizes read may still spend on measuring documents. */
export type MeasureBudget = { remaining: number };

/**
 * Remembers the measured size of each document value it has seen, and sums a
 * replica's documents from those measurements within a budget. A value is
 * remembered for as long as the replica holds it: the cache is keyed weakly
 * by the value object, and a document whose confirmed value is replaced is
 * measured afresh.
 */
export class DocumentSizeEstimate {
  readonly #measured = new WeakMap<object, number>();

  /**
   * Sums the confirmed `values` of one replica's documents. A value already
   * measured costs a lookup; one not yet measured is walked while `budget`
   * has nodes left, and left for a later read otherwise. An absent document,
   * whose value is `undefined`, counts as measured at no bytes.
   */
  measure(
    values: Iterable<EntityDocument | undefined>,
    budget: MeasureBudget,
  ): { documents: number; measuredDocuments: number; approxBytes: number } {
    let documents = 0;
    let measuredDocuments = 0;
    let measuredBytes = 0;
    for (const value of values) {
      documents++;
      if (value === undefined) {
        measuredDocuments++;
        continue;
      }
      let bytes = this.#measured.get(value);
      if (bytes === undefined) {
        if (budget.remaining <= 0) continue;
        const size = approximateJsonSize(value);
        budget.remaining -= size.nodes;
        bytes = size.bytes;
        // A document is an object, and only an object can key the cache; a
        // value that is not one is measured again each read, which costs
        // what one leaf costs.
        if (typeof value === "object") this.#measured.set(value, bytes);
      }
      measuredDocuments++;
      measuredBytes += bytes;
    }
    const approxBytes =
      measuredDocuments === documents || measuredDocuments === 0
        ? measuredBytes
        : Math.round(measuredBytes / measuredDocuments * documents);
    return { documents, measuredDocuments, approxBytes };
  }
}
