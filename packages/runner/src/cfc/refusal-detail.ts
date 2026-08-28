// Why: a refusal that names only what it refused leaves the refused party with
// nothing to do about it.
//
// `sink-request confidentiality exceeds ceiling for fetchText: "medical"` is a
// complete statement of the verdict and a useless instruction. It says a
// confidentiality atom reached an egress that does not admit it; it does not
// say WHICH of the transaction's reads carried that atom in. An agent holding
// three inputs and one refusal cannot tell which input to drop, so it either
// drops all of them (losing the run) or retries unchanged (refused again).
//
// A refusal detail answers the second question. It names the boundary that
// refused, the atoms outside it, and the reads that carried each one — and it
// states, as a checkable property rather than a promise, whether those reads
// account for every offending atom. When they do, dropping them is a REMEDY:
// the same operation over the remaining inputs meets the ceiling. When they do
// not, the detail says so, and the caller learns that taint minimization alone
// will not clear this one.
//
// The detail rides ALONGSIDE the reason string, never inside it. The reason is
// prose for a person and a matcher; encoding a structure into it would make
// every consumer a parser and every rewording a breaking change.

import type { CfcAddress } from "./types.ts";

/**
 * One read that carried a confidentiality atom into a transaction, paired
 * with the label-map entry path that carried it. The collector in `prepare.ts`
 * builds these; a gate that refuses turns the ones behind its offending atoms
 * into {@link CfcRefusalInput}s.
 */
export interface ConsumedAtomSource {
  readonly read: CfcAddress;
  readonly labelPath: readonly string[];
}

/**
 * How an atom is rendered wherever it is named — in a reason string, in a
 * detail, and as the key a source map is built on. One function, so a
 * consumer matching a detail's atoms against a reason's prose compares
 * identical text.
 */
export const renderCfcAtom = (atom: unknown): string => JSON.stringify(atom);

/** Dedup key for a source: one entry per (address, label path). */
export const consumedAtomSourceKey = (source: ConsumedAtomSource): string =>
  JSON.stringify([
    source.read.space,
    source.read.id,
    source.read.scope,
    source.read.path,
    source.labelPath,
  ]);

/** Which gate refused. Named for the rule, so a consumer can branch on it. */
export type CfcRefusalGate = "sink-ceiling" | "writer-fit";

/**
 * One read that carried offending confidentiality into a refused operation.
 *
 * `read` is the address the transaction actually read; `labelPath` is the
 * label-map entry path inside that document which carried the atoms. The two
 * differ whenever a read of a container picks up a label declared on a field
 * inside it — which is the common case, and the one where naming only the
 * document would under-specify the remedy.
 */
export interface CfcRefusalInput {
  readonly read: CfcAddress;
  readonly labelPath: readonly string[];

  /** The offending atoms this read contributed, JSON-rendered as the reason
   * strings render them, so detail and prose name atoms identically. */
  readonly atoms: readonly string[];
}

/**
 * How completely {@link CfcRefusalDetail.inputs} accounts for the refusal.
 *
 * - `complete` — every offending atom is attributed to a named read. Dropping
 *   all of them clears this refusal.
 * - `partial` — some offending atom is attributed to no named read. Dropping
 *   the named ones narrows the flow without necessarily clearing it.
 * - `none` — nothing was attributed. The gate still refused; the detail adds
 *   no remedy beyond the reason.
 *
 * An exchange-rule rewrite is the ordinary way to land below `complete`: the
 * gate decides on a REWRITTEN label whose clauses need not be any clause a
 * read contributed, so an atom can be genuinely offending and genuinely
 * unattributable. Reporting that honestly is the point — a confident wrong
 * remedy costs more than an admitted gap.
 */
export type CfcRefusalAttribution = "complete" | "partial" | "none";

/**
 * A refusal, described in terms a caller can act on.
 *
 * Every field is data a consumer reads structurally: the harness turns
 * `inputs` into the argument names an agent passed, and a console renders the
 * boundary and the atoms. Nothing here is meant to be parsed out of prose.
 */
export interface CfcRefusalDetail {
  readonly gate: CfcRefusalGate;

  /** The sink whose ceiling refused, for `sink-ceiling`. */
  readonly sink?: string;

  /** The write the rule refused, for `writer-fit`. */
  readonly target?: CfcAddress;

  /** Atoms outside what the boundary admits, JSON-rendered. */
  readonly offendingAtoms: readonly string[];

  /** The reads that carried them, deduplicated by address. */
  readonly inputs: readonly CfcRefusalInput[];

  readonly attribution: CfcRefusalAttribution;

  /**
   * The plain reason text this detail describes, verbatim — the pairing key
   * between the structured detail and the reason list a refusal carries. The
   * commit boundary keeps only the details whose reason survived into the
   * refusal, so a detail recorded for a reason that did not refuse (an
   * observe-mode diagnostic, a rule that later resolved) never rides along.
   */
  readonly reason: string;
}

/**
 * Turn the sources behind `offendingAtoms` into the refusal's inputs: one
 * entry per contributing read, carrying every offending atom that read
 * supplied. An atom no source claims is simply absent, which is what drops
 * {@link CfcRefusalDetail.attribution} below `complete`.
 */
export const refusalInputsFor = (
  offendingAtoms: readonly string[],
  sources: ReadonlyMap<string, readonly ConsumedAtomSource[]>,
): readonly CfcRefusalInput[] => {
  const byRead = new Map<
    string,
    { source: ConsumedAtomSource; atoms: string[] }
  >();
  for (const atom of offendingAtoms) {
    for (const source of sources.get(atom) ?? []) {
      const key = consumedAtomSourceKey(source);
      const existing = byRead.get(key);
      if (existing === undefined) byRead.set(key, { source, atoms: [atom] });
      else if (!existing.atoms.includes(atom)) existing.atoms.push(atom);
    }
  }
  return [...byRead.values()].map(({ source, atoms }) => ({
    read: source.read,
    labelPath: source.labelPath,
    atoms,
  }));
};

/**
 * Classify how completely {@link CfcRefusalDetail.inputs} accounts for
 * `offendingAtoms`.
 *
 * Compares the rendered atom strings rather than the clause values: the
 * renderings are what both the reason and the detail publish, so a consumer
 * matching one against the other sees the same answer this does.
 */
export const refusalAttribution = (
  offendingAtoms: readonly string[],
  inputs: readonly CfcRefusalInput[],
): CfcRefusalAttribution => {
  if (inputs.length === 0) return "none";
  const attributed = new Set(inputs.flatMap((input) => [...input.atoms]));
  return offendingAtoms.every((atom) => attributed.has(atom))
    ? "complete"
    : "partial";
};
