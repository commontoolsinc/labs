/**
 * Runtime-owned provenance for reference identities. Associations follow live
 * carriers and label-view transformations; serialized label fields carry no
 * acquisition authority. Target content labels are resolved independently.
 */

import { deepFreeze } from "@commonfabric/data-model";
import { deepEqual } from "@commonfabric/utils/deep-equal";

import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { ScopeCapAtDepth } from "../link-types.ts";
import { type CfcConfClause, clausesEqual } from "./clause.ts";
import type { CfcLabelView } from "./label-view-core.ts";
import type { CfcAddress } from "./types.ts";

/** The complete binding whose identity was acquired by the runtime. */
export type CfcReferenceBinding = CfcAddress & {
  readonly overwrite?: "redirect";
};

/** Historical identity restrictions, separate from current target contents. */
export type CfcReferenceProvenance = {
  readonly binding: CfcReferenceBinding;
  readonly confidentiality: readonly CfcConfClause[];
  readonly scopeCaps?: readonly ScopeCapAtDepth[];
};

/** An application observation of a previously acquired reference. */
export type CfcReferenceObservation = {
  readonly target: CfcReferenceBinding;
  readonly confidentiality: readonly CfcConfClause[];
  readonly purpose: "identity" | "dereference";
  readonly journalIndex: number;
};

const carriers = new WeakMap<object, () => CfcReferenceProvenance>();
const carrierViews = new WeakMap<object, () => CfcLabelView | undefined>();
const views = new WeakMap<object, readonly CfcConfClause[]>();

/** Shared empty restriction list for views without recorded reference history. */
const emptyConfidentiality: readonly CfcConfClause[] = Object.freeze([]);

/** Registers a runtime-owned carrier; this mint stays package-internal. */
export function registerCfcReferenceCarrier(
  carrier: object,
  provenance: () => CfcReferenceProvenance,
  view?: () => CfcLabelView | undefined,
): void {
  carriers.set(carrier, provenance);
  if (view !== undefined) carrierViews.set(carrier, view);
  else carrierViews.delete(carrier);
}

/** Reads provenance only from a carrier registered by the runtime. */
export function getCfcReferenceProvenance(
  value: unknown,
): CfcReferenceProvenance | undefined {
  return typeof value === "object" && value !== null
    ? carriers.get(value)?.()
    : undefined;
}

/** Reads private view state retained by a runtime-owned reference carrier. */
export function getCfcReferenceView(value: unknown): CfcLabelView | undefined {
  return typeof value === "object" && value !== null
    ? carrierViews.get(value)?.()
    : undefined;
}

/** Preserves a trusted carrier's provenance on its serialized link object. */
export function carryCfcReferenceProvenance<T>(
  source: unknown,
  target: T,
): T {
  const provenance = getCfcReferenceProvenance(source);
  if (
    provenance !== undefined && typeof target === "object" && target !== null
  ) {
    const frozen = deepFreeze(provenance);
    carriers.set(target, () => frozen);
    const view = getCfcReferenceView(source);
    if (view !== undefined) carrierViews.set(target, () => view);
    else carrierViews.delete(target);
  }
  return target;
}

/** Projects a normalized link to its confidentiality-bearing identity. */
export function cfcReferenceBinding(
  link: CfcReferenceBinding,
): CfcReferenceBinding {
  return {
    space: link.space,
    id: link.id,
    scope: link.scope,
    path: [...link.path],
    ...(link.overwrite === "redirect" ? { overwrite: "redirect" } : {}),
  };
}

/** Checks that a carried acquisition still names the link being used. */
export function cfcReferenceBindingMatches(
  provenance: CfcReferenceProvenance,
  link: CfcReferenceBinding,
): boolean {
  return deepEqual(provenance.binding, cfcReferenceBinding(link));
}

/** Reads the historical reference restrictions associated with a live view. */
export function cfcReferenceConfidentialityForView(
  view: CfcLabelView | undefined,
): readonly CfcConfClause[] {
  return view === undefined
    ? emptyConfidentiality
    : views.get(view) ?? emptyConfidentiality;
}

/**
 * Carries runtime-derived reference restrictions through a view transformation.
 * A reference entry keeps the view present when a descendant slice has no
 * target labels of its own.
 */
export function withCfcReferenceConfidentiality(
  view: CfcLabelView | undefined,
  confidentiality: readonly CfcConfClause[],
): CfcLabelView | undefined {
  if (confidentiality.length === 0) return view;
  const referenceEntry = {
    path: [],
    observes: "followRef" as const,
    label: { confidentiality: [...confidentiality] },
  };
  const existing =
    view?.entries.flatMap((entry) =>
      entry.path.length === 0 && entry.observes === "followRef"
        ? entry.label.confidentiality ?? []
        : []
    ) ?? [];
  const covered = confidentiality.every((clause) =>
    existing.some((candidate) => clausesEqual(candidate, clause))
  );
  const result: CfcLabelView = covered && view !== undefined ? view : {
    version: 1,
    entries: [...(view?.entries ?? []), referenceEntry],
  };
  const retained = [...cfcReferenceConfidentialityForView(view)];
  for (const clause of confidentiality) {
    if (!retained.some((candidate) => clausesEqual(candidate, clause))) {
      retained.push(clause);
    }
  }
  views.set(result, deepFreeze(retained));
  return result;
}

/** Joins retained reference restrictions from independently derived views. */
export function joinCfcReferenceConfidentiality(
  sources: readonly (CfcLabelView | undefined)[],
): readonly CfcConfClause[] {
  const joined: CfcConfClause[] = [];
  for (const view of sources) {
    for (const clause of cfcReferenceConfidentialityForView(view)) {
      if (!joined.some((existing) => clausesEqual(existing, clause))) {
        joined.push(clause);
      }
    }
  }
  return joined;
}

/** Records retained reference restrictions at an application observation. */
export function recordCfcReferenceObservation(
  tx: IExtendedStorageTransaction,
  provenance: CfcReferenceProvenance | undefined,
  purpose: CfcReferenceObservation["purpose"],
): void {
  if (
    provenance === undefined || provenance.confidentiality.length === 0 ||
    tx.getCfcState().enforcementMode === "disabled"
  ) return;
  const clock = tx.currentActivityIndex?.();
  let index = (clock ?? 0) - 1;
  if (clock === undefined) {
    for (const read of tx.getReadActivities?.() ?? []) {
      index = Math.max(index, read.journalIndex ?? -1);
    }
    for (const write of tx.getWriteAttemptLog?.() ?? []) {
      index = Math.max(index, write.journalIndex);
    }
  }
  tx.recordCfcReferenceObservation({
    target: provenance.binding,
    confidentiality: provenance.confidentiality,
    purpose,
    journalIndex: index + 0.5,
  });
}
