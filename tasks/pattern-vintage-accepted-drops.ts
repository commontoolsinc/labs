/**
 * Fields a pattern removed on purpose, and therefore no longer owes a vintage.
 *
 * Tier 2 asks whether a real document written by an older version is still
 * readable by the version about to merge, and its default answer to "no" is
 * that the update lost data. That answer is right almost every time: a moved
 * `.for()` key strands state while the declared contract does not change by a
 * byte, which is exactly the failure the tier exists for.
 *
 * It is not right when the field was removed on purpose. The feature behind it
 * is gone, the state it held is an accepted casualty, and no change to the
 * pattern makes the vintage readable again — the comparison is measuring the
 * decision itself. That is a Tier 1 conversation first: a removal reaches here
 * only after `tasks/pattern-compat-accepted-breaks.ts` has already accepted it
 * as a contract break, and these two lists are meant to be read together.
 *
 * An entry names FIELDS, not fixtures, and that bound is what keeps it from
 * becoming an off switch. The named fields are removed from the vintage's side
 * of the comparison — the version that wrote it is simply not asked about them
 * — wherever they sit, at the root or nested under a list of children. Every
 * other field on the same root is still compared exactly as before, so a
 * removal that also strands a body, a thread, or a timestamp still fails.
 *
 * The list can only shrink. An entry that removes nothing from any vintage the
 * run replays fails it, so an exemption cannot outlive the removal it was
 * granted for.
 */
export interface AcceptedStateDrop {
  /** Pattern key: the path relative to `packages/patterns`. */
  pattern: string;
  /** Property names this pattern's contract no longer declares. */
  fields: readonly string[];
  /** Why the removal was accepted. */
  reason: string;
}

export const ACCEPTED_STATE_DROPS: readonly AcceptedStateDrop[] = [
  {
    pattern: "topics/main.tsx",
    // `crossrefs` was the board's published graph; `refsOut` / `referencedBy`
    // are the edge sets every row of it carried, which also reached the old
    // `index` rows and each child topic inside `topics` and `mentionable`.
    fields: ["crossrefs", "refsOut", "referencedBy"],
    reason:
      "Cross-reference links removed from Topics — see the matching entry in " +
      "tasks/pattern-compat-accepted-breaks.ts. Board rows keep their fid, " +
      "reference and summary scalars; only the edges go.",
  },
  {
    pattern: "topics/topic.tsx",
    // A topic's own row, and the two edge sets plus the durable link snapshots
    // it carried.
    fields: [
      "crossrefs",
      "refsOut",
      "referencedBy",
      "refsOutLinks",
      "referencedByLinks",
    ],
    reason:
      "Cross-reference links removed from Topics — see the matching entry in " +
      "tasks/pattern-compat-accepted-breaks.ts. A topic no longer derives an " +
      "edge row, so nothing reads these paths.",
  },
];

/**
 * The fields accepted as dropped for one pattern.
 *
 * A manifest entry names its pattern by repo-relative path
 * (`/packages/patterns/topics/topic.tsx`), so the key is matched as a path
 * suffix rather than a bare one: `endsWith("topics/main.tsx")` alone would also
 * claim a `subtopics/main.tsx` that no entry mentions.
 */
export function acceptedDropsFor(
  patternPath: string,
  drops: readonly AcceptedStateDrop[] = ACCEPTED_STATE_DROPS,
): { fields: ReadonlySet<string>; pattern: string } | undefined {
  const entry = drops.find((drop) =>
    patternPath === drop.pattern || patternPath.endsWith(`/${drop.pattern}`)
  );
  return entry === undefined
    ? undefined
    : { fields: new Set(entry.fields), pattern: entry.pattern };
}

/**
 * `state` with every accepted field removed, at any depth, and whether removing
 * them changed anything.
 *
 * Rebuilt rather than mutated: the caller's snapshot is the vintage's own read
 * and is compared against more than once. Arrays are walked because that is
 * where the fields actually sit — a board's `topics` is a list of children,
 * each of which carried the removed path.
 *
 * The `applied` flag is what makes the list shrink. An entry whose fields are
 * nowhere in any vintage forgives nothing, and a gate cannot tell that from an
 * entry that is quietly doing nothing unless it counts.
 */
export function withoutAcceptedDrops(
  state: unknown,
  fields: ReadonlySet<string>,
): { value: unknown; applied: boolean } {
  if (fields.size === 0) return { value: state, applied: false };
  let applied = false;
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (typeof value !== "object" || value === null) return value;
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (fields.has(key)) {
        applied = true;
        continue;
      }
      out[key] = strip(nested);
    }
    return out;
  };
  return { value: strip(state), applied };
}
