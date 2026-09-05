/**
 * A runtime's security posture, and what it means for two of them to agree.
 *
 * One runtime acts as one principal under one enforcement configuration. A
 * client that attaches asserts the posture it believes it is joining, and this
 * is where that assertion is settled. Both ends build a context, so the pieces
 * live here rather than on either side of the IPC.
 */

import { deepEqual } from "@commonfabric/utils/deep-equal";
import type { CfcConfClause } from "@commonfabric/runner/cfc";

import type { RuntimeSecurityContext } from "@/protocol/mod.ts";

/**
 * One spelling for one origin. A `URL` round-trip settles the variance two
 * documents can differ by while meaning the same host -- an absent trailing
 * slash, a default port written out -- so that agreeing on a backend does not
 * depend on agreeing on how to write it. A value no `URL` can parse is left as
 * it stands and compares literally, which is what an unparseable host
 * deserves.
 */
export function normalizeOrigin(value: string): string {
  try {
    return new URL(value).toString();
  } catch {
    return value;
  }
}

/**
 * A host map whose origins are spelled one way, or `undefined` where there is
 * no map. An empty map and an absent one are the same posture -- every space
 * resolving to the backend -- and both read as `undefined` here, so the two
 * spellings of "no per-space hosts" do not refuse each other.
 */
export function normalizeSpaceHostMap(
  map: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (map === undefined) return undefined;
  const entries = Object.entries(map);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(
    entries.map(([space, origin]) => [space, normalizeOrigin(origin)]),
  );
}

/**
 * Every field a {@link RuntimeSecurityContext} carries, as a record so that a
 * field added to that type and not to this one is a type error. What an attach
 * is checked against has to be the whole context: a field nobody compares is a
 * posture a second document can hold while the first believes otherwise.
 */
const SECURITY_CONTEXT_FIELDS: Record<
  keyof Required<RuntimeSecurityContext>,
  true
> = {
  apiUrl: true,
  cfcEnforcementMode: true,
  cfcFlowLabels: true,
  cfcReadMaxConfidentiality: true,
  cfcReadOnExceed: true,
  experimental: true,
  identity: true,
  renderConfidentialityCeiling: true,
  renderDeclassificationPolicy: true,
  spaceDid: true,
  spaceHostMap: true,
  trustSnapshot: true,
};

/**
 * The fields on which `asserted` and `running` disagree, in a fixed order, or
 * an empty list where they agree throughout.
 *
 * Compared field by field rather than as two whole objects: the two are built
 * in different documents and one of them crossed an encoding, so a posture
 * carried as an absent property in one and as an explicit `undefined` in the
 * other is the same posture and compares equal here.
 */

/**
 * A read ceiling compares by clause, insensitive to the order of an
 * `anyOf`'s alternatives and to the order of the clauses themselves (a
 * ceiling is a conjunction), so two documents that spell one ceiling in
 * another order hold the same posture and a byte comparison would fail the
 * attach over spelling. Structural, not the runner's `clausesEqual`: this
 * file is loaded on the browser's main thread, and the runner's CFC barrel
 * reaches modules that refuse to run there.
 */
const canonicalAtom = (atom: unknown): string =>
  JSON.stringify(
    atom,
    (_key, value) =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0
          ),
        )
        : value,
  );

const canonicalClause = (clause: unknown): string => {
  const alternatives = clause !== null && typeof clause === "object" &&
      Array.isArray((clause as { anyOf?: unknown }).anyOf)
    ? (clause as { anyOf: unknown[] }).anyOf
    : undefined;
  if (alternatives === undefined) return canonicalAtom(clause);
  const unique = [...new Set(alternatives.map(canonicalAtom))].sort();
  return unique.length === 1 ? unique[0] : `anyOf:${JSON.stringify(unique)}`;
};

function readCeilingsEqual(
  left: readonly CfcConfClause[] | undefined,
  right: readonly CfcConfClause[] | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.length !== right.length) return false;
  const l = left.map(canonicalClause).sort();
  const r = right.map(canonicalClause).sort();
  return l.every((clause, i) => clause === r[i]);
}

export function securityContextDifferences(
  asserted: RuntimeSecurityContext,
  running: RuntimeSecurityContext,
): string[] {
  const fields = Object.keys(SECURITY_CONTEXT_FIELDS).sort() as (
    keyof RuntimeSecurityContext
  )[];
  return fields.filter((field) =>
    field === "cfcReadMaxConfidentiality"
      ? !readCeilingsEqual(asserted[field], running[field])
      : !deepEqual(asserted[field], running[field])
  );
}
