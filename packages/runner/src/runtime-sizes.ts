/**
 * Sizes of the structures a runtime holds live, for the diagnostics read that
 * attributes a growing heap to the structure growing it. Every figure is a
 * collection's own count, so reading them walks nothing: a read is safe at any
 * moment, including one where the runtime is already struggling.
 */

import type { SchedulerSizes } from "./scheduler/types.ts";
import type { StorageSizes } from "./storage/diagnostics.ts";

/** Sizes of the pattern manager's in-memory compiled-code caches. */
export type PatternManagerSizes = {
  /** Compiled programs held by content identity. */
  compiledPrograms: number;

  /** Module namespaces held by content identity. */
  evaluatedModules: number;

  /** Module identities whose builder artifacts are indexed for lookup. */
  indexedModules: number;

  /** Compilations in flight. */
  inProgressCompilations: number;
};

/** Sizes of the structures the runtime itself holds. */
export type RuntimeOwnSizes = {
  /** Snapshots the immutable cell store retains. */
  immutableSnapshots: number;

  /** Asynchronous builtin work not yet settled. */
  pendingAsyncWork: number;

  /** `editWithRetry()` calls waiting to attempt their commit again. */
  retryingEdits: number;

  /** Modules registered by reference. */
  modules: number;

  /** CFC policy manifests resolved and held. */
  policyManifests: number;
};

/** What `Runtime.getSizes()` reports. */
export type RuntimeSizes = {
  scheduler: SchedulerSizes;

  /** Null when the storage manager reports no sizes. */
  storage: StorageSizes | null;

  patterns: PatternManagerSizes;
  runtime: RuntimeOwnSizes;

  /**
   * Commits CFC enforcement refused before they reached storage, by the
   * opening words of each reason that refused them. A commit refused for
   * several reasons counts once under each.
   */
  cfcRejectionsByReason: Record<string, number>;
};

/** The longest prefix a reason is tallied under. */
const CFC_REJECTION_REASON_PREFIX_LIMIT = 80;

/** How many distinct prefixes a tally holds before the rest share one key. */
export const CFC_REJECTION_REASON_LIMIT = 64;

/** The key every prefix past {@link CFC_REJECTION_REASON_LIMIT} counts under. */
export const CFC_REJECTION_REASON_OTHER = "(other)";

/** The key for a reason with no words ahead of its first identifier. */
const CFC_REJECTION_REASON_UNCLASSIFIED = "(unclassified)";

/**
 * Returns the words of a CFC refusal reason ahead of the first thing it names:
 * the rule that refused, without the document, path or sink it refused. A
 * reason names what it refused after ` for `, ` at ` or `:`, so the cut falls
 * at the first of those. `"writer-fit confidentiality misfit for of:… at /"`
 * tallies as `"writer-fit confidentiality misfit"`.
 */
export function cfcRejectionReasonPrefix(reason: string): string {
  const cut = reason.search(/ (?:for|at) |:/);
  const prefix = (cut === -1 ? reason : reason.slice(0, cut)).trim();
  if (prefix.length === 0) return CFC_REJECTION_REASON_UNCLASSIFIED;
  return prefix.slice(0, CFC_REJECTION_REASON_PREFIX_LIMIT);
}

/**
 * Counts CFC commit refusals by reason prefix, bounded in distinct keys so a
 * reason that varies in its opening words cannot grow the tally without
 * limit.
 */
export class CfcRejectionTally {
  readonly #counts = new Map<string, number>();

  /** Counts one refusal under each of its reasons' prefixes. */
  add(reasons: readonly string[]): void {
    for (const reason of reasons) {
      let key = cfcRejectionReasonPrefix(reason);
      if (
        !this.#counts.has(key) &&
        this.#counts.size >= CFC_REJECTION_REASON_LIMIT
      ) {
        key = CFC_REJECTION_REASON_OTHER;
      }
      this.#counts.set(key, (this.#counts.get(key) ?? 0) + 1);
    }
  }

  /** The counts so far, as a plain record. */
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.#counts);
  }
}
