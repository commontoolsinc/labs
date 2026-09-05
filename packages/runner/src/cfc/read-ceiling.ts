/**
 * The runtime-wide read ceiling: a confidentiality ceiling every `db.query`
 * the runtime issues reads under, whether or not the query declares one of
 * its own. Declared through `RuntimeOptions.cfcReadMaxConfidentiality` and
 * `cfcReadOnExceed`, validated and frozen here at construction.
 *
 * A pattern can declare a per-query ceiling, but the only carrier a pattern
 * can read is a cell in the space, which every runtime on the space shares.
 * A ceiling that has to differ per runtime — a per-device lens, a per-run
 * clearance — therefore cannot live in a pattern's inputs. It lives on the
 * runtime, and the query builtin meets it with whatever the query declares,
 * so the query can tighten the runtime's ceiling and never widen it.
 */

import { isObjectNotArray } from "@commonfabric/utils/types";

import type { CfcConfClause } from "./clause.ts";
import { isOrClause } from "./clause.ts";

/** What a read does with a row the runtime's ceiling does not admit. */
export type CfcReadOnExceed = "fail" | "skip";

/**
 * The read ceiling's inputs, in the shape `RuntimeOptions` carries them.
 * Both absent is the owner view: no ceiling, every row returned. The mode
 * qualifies the ceiling and is refused without one.
 */
export interface CfcReadCeilingOptions {
  /** See `RuntimeOptions.cfcReadMaxConfidentiality`. */
  cfcReadMaxConfidentiality?: readonly CfcConfClause[];

  /** See `RuntimeOptions.cfcReadOnExceed`. */
  cfcReadOnExceed?: CfcReadOnExceed;
}

/** The validated, deep-frozen form a `Runtime` holds. */
export interface CfcReadCeiling {
  /** The ceiling, or `undefined` for none. */
  readonly maxConfidentiality: readonly CfcConfClause[] | undefined;

  /**
   * The mode a read falls back to when its query declares no `onExceed` of
   * its own, or `undefined` to leave the builtin's default in force.
   */
  readonly onExceed: CfcReadOnExceed | undefined;
}

/**
 * The names a refusal reports the two inputs under. A host validating the
 * same shape from another surface — a run manifest field, a command-line
 * flag — passes its own, so the refusal names the field the operator wrote.
 */
export interface CfcReadCeilingLabels {
  /** Name of the ceiling field; defaults to `cfcReadMaxConfidentiality`. */
  readonly ceiling?: string;

  /** Name of the mode field; defaults to `cfcReadOnExceed`. */
  readonly onExceed?: string;
}

/**
 * Whether `value` is a well-formed atom for a ceiling: a non-empty string or
 * a plain record that is not itself an OR-clause. A placeholder such as
 * `{ __ctDbOwner: true }` is a record, so it passes here and resolves per
 * query.
 */
const isCeilingAtom = (value: unknown): boolean =>
  (typeof value === "string" && value.length > 0) ||
  (isObjectNotArray(value) && !isOrClause(value));

const freezeClause = (clause: CfcConfClause): CfcConfClause =>
  isOrClause(clause)
    ? Object.freeze({ anyOf: Object.freeze([...clause.anyOf]) })
    : (isObjectNotArray(clause) ? Object.freeze({ ...clause }) : clause);

/**
 * Validates the read-ceiling options and returns the frozen form, or throws
 * on a malformed one so a configuration error surfaces at boot rather than
 * as a ceiling that silently admits nothing or everything.
 *
 * Refused: a ceiling that is not an array; an EMPTY ceiling, which admits no
 * confidential atom at all and is never what a caller who wrote one meant (a
 * caller wanting no ceiling omits the option); an entry that is neither an
 * atom nor an `anyOf` of atoms; an `anyOf` with no alternatives, which no
 * label can satisfy; an `onExceed` outside `fail` and `skip`; and an
 * `onExceed` without a ceiling, which would have nothing to qualify and would
 * otherwise reach a query's own ceiling as a default the query did not
 * declare.
 *
 * Bound: this is a shape check. It does not resolve placeholders, which need
 * the acting principal and the db owner of each query, and it does not judge
 * whether an atom names a principal that exists.
 *
 * @throws If either option is malformed, naming the field under `labels`.
 */
export function buildCfcReadCeiling(
  options: CfcReadCeilingOptions,
  labels: CfcReadCeilingLabels = {},
): CfcReadCeiling {
  const { cfcReadMaxConfidentiality: ceiling, cfcReadOnExceed: onExceed } =
    options;
  const ceilingName = labels.ceiling ?? "cfcReadMaxConfidentiality";
  const onExceedName = labels.onExceed ?? "cfcReadOnExceed";
  if (
    onExceed !== undefined && onExceed !== "fail" && onExceed !== "skip"
  ) {
    throw new Error(
      `${onExceedName}: expected "fail" or "skip", got ${
        JSON.stringify(onExceed)
      }`,
    );
  }
  if (ceiling === undefined) {
    if (onExceed !== undefined) {
      throw new Error(
        `${onExceedName}: qualifies \`${ceilingName}\`, which is not set — ` +
          "set both, or neither",
      );
    }
    return Object.freeze({ maxConfidentiality: undefined, onExceed });
  }
  if (!Array.isArray(ceiling)) {
    throw new Error(`${ceilingName}: expected an array of clauses`);
  }
  if (ceiling.length === 0) {
    throw new Error(
      `${ceilingName}: an empty ceiling admits nothing — omit the field for ` +
        "no ceiling",
    );
  }
  ceiling.forEach((clause, index) => {
    const where = `${ceilingName}[${index}]`;
    if (isOrClause(clause)) {
      if (clause.anyOf.length === 0) {
        throw new Error(`${where}: an \`anyOf\` with no alternatives`);
      }
      clause.anyOf.forEach((alternative, i) => {
        if (!isCeilingAtom(alternative)) {
          throw new Error(
            `${where}.anyOf[${i}]: expected an atom, got ${
              JSON.stringify(alternative)
            }`,
          );
        }
      });
      return;
    }
    if (!isCeilingAtom(clause)) {
      throw new Error(
        `${where}: expected an atom or an \`anyOf\` of atoms, got ${
          JSON.stringify(clause)
        }`,
      );
    }
  });
  return Object.freeze({
    maxConfidentiality: Object.freeze(ceiling.map(freezeClause)),
    onExceed,
  });
}
