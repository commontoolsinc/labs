/**
 * State a pattern stopped holding on purpose, and therefore no longer owes a
 * vintage.
 *
 * Tier 2 asks whether a real document written by an older version is still
 * readable by the version about to merge, and its default answer to "no" is
 * that the update lost data. That answer is right almost every time: a moved
 * `.for()` key strands state while the declared contract does not change by a
 * byte, which is exactly the failure the tier exists for.
 *
 * It is not right when the state was removed on purpose. The feature behind it
 * is gone, what it held is an accepted casualty, and no change to the pattern
 * makes the vintage readable again — the comparison is measuring the decision
 * itself. That is a Tier 1 conversation first: a removal reaches here only
 * after `tasks/pattern-compat-accepted-breaks.ts` has already accepted it as a
 * contract break, and the two lists are meant to be read together.
 *
 * An entry names PATHS, not fixtures and not bare field names, and that bound
 * is what keeps it from becoming an off switch. `crossrefs` forgives the root
 * key of that name and nothing else; `topics[].crossrefs` forgives it on each
 * element of the `topics` list. A same-named field anywhere else — on an
 * unrelated nested object, under a different root — is compared exactly as
 * before, so a removal that also strands a body, a thread, or a timestamp
 * still fails.
 *
 * Nothing off the path to an accepted drop is rebuilt, either: the comparison
 * has to see the state it was handed, and a subtree that lost nothing is
 * returned as itself rather than as a copy of itself.
 *
 * An entry is bounded in TIME as well, by `capturedThrough`. A removal happened
 * once, and only the vintages captured before it hold state that cannot roll
 * forward — so a vintage captured later is compared with no exemption at all.
 * That is what keeps a REPLACED path honest: `crossrefs` is still published,
 * carrying pivot rows now, and an entry that forgave it forever would hide a
 * later change that stranded those.
 *
 * The list can only shrink. A path that removes nothing from any vintage in its
 * own window fails the run, so an exemption cannot outlive the removal it was
 * granted for.
 */
export interface AcceptedStateDrop {
  /** Pattern key: the path relative to `packages/patterns`. */
  pattern: string;
  /**
   * Dotted paths into the pattern's result state that it no longer holds.
   * A segment ending in `[]` steps through every element of that list.
   */
  paths: readonly string[];
  /**
   * Capture stamp of the newest vintage this entry forgives, as
   * `VintageRef.stamp` spells one (ISO-8601 with `:` replaced, so it sorts as
   * a string).
   *
   * A removal happened once, at a point in time, and only the vintages
   * captured before it hold the state that cannot roll forward. Without this
   * bound an entry would also strip the path out of every vintage captured
   * LATER, which matters most where a path was replaced rather than retired:
   * `crossrefs` still exists on the board, carrying pivot rows, and an
   * unbounded entry would hide a future change that stranded those too. The
   * exemption covers the removal it was granted for and stops there.
   */
  capturedThrough: string;
  /** Why the removal was accepted. */
  reason: string;
}

export const ACCEPTED_STATE_DROPS: readonly AcceptedStateDrop[] = [
  {
    pattern: "topics/main.tsx",
    paths: [
      // `crossrefs` is listed WHOLE, and that is the honest shape of what
      // happened: the old graph row carried an fid, a title, summary counts and
      // two edge sets, and the pivot row that replaced it carries a topic and
      // who mentions it. Nothing of the old row survives to be compared field
      // by field.
      "crossrefs",
      // The old index rows carried the same two edge sets beside their
      // summaries. The summaries themselves are untouched.
      "index[].refsOut",
      "index[].referencedBy",
      // An index row IS its topic now, so the title-only reference that used to
      // sit beside it goes; the row's own address is the topic's. The copied
      // `fid` field goes with it, and needs no entry here: no replayed vintage
      // holds a resolved one.
      "index[].topic",
      // The retired per-topic edge row, seen through each of the board's two
      // lists of children.
      "topics[].crossrefs",
      "mentionable[].crossrefs",
    ],
    // The newest topics vintage predating the rebuild. Both replayed fixtures
    // sit at or under it, and any captured from here on hold the pivot rows,
    // which owe the comparison the same answer as anything else.
    capturedThrough: "2026-08-06T23-04-13.189Z",
    reason:
      "Topics' reference graph was rebuilt on cell identity — see the matching " +
      "entry in tasks/pattern-compat-accepted-breaks.ts. A topic publishes " +
      "`referencedBy` instead of deriving its own edge row, so the old row is " +
      "gone from every child the board lists. The index rows became the topics " +
      "themselves, which is what retires their copied address and reference.",
  },
  {
    pattern: "topics/topic.tsx",
    // The topic's own edge row, whole. A topic no longer derives one: inbound
    // references are read out of the board's pivot and published as
    // `referencedBy`, so nothing reads this path.
    paths: ["crossrefs"],
    capturedThrough: "2026-08-06T23-04-13.189Z",
    reason:
      "Topics' reference graph was rebuilt on cell identity — see the matching " +
      "entry in tasks/pattern-compat-accepted-breaks.ts. The board's own " +
      "`crossrefs` came back as a pivot and strands nothing, so only a topic's " +
      "retired per-topic row is listed here.",
  },
];

/** One `(pattern, path)` drop, for reporting which entries were needed. */
export const acceptedDropKey = (pattern: string, path: string): string =>
  `${pattern} ${path}`;

/**
 * The paths accepted as dropped for one pattern, in one vintage.
 *
 * A manifest entry names its pattern by repo-relative path
 * (`/packages/patterns/topics/topic.tsx`), so the key is matched as a path
 * suffix rather than a bare one: `endsWith("topics/main.tsx")` alone would also
 * claim a `subtopics/main.tsx` that no entry mentions.
 *
 * `stamp` is the replayed vintage's capture stamp, and an entry answers only
 * for the vintages it was granted over. Stamps are ISO-8601 with `:` replaced,
 * which leaves them sortable as plain strings — so the window is a string
 * comparison and needs no date parsing.
 */
export function acceptedDropsFor(
  patternPath: string,
  stamp: string,
  drops: readonly AcceptedStateDrop[] = ACCEPTED_STATE_DROPS,
): { paths: ReadonlySet<string>; pattern: string } | undefined {
  const entry = drops.find((drop) =>
    (patternPath === drop.pattern ||
      patternPath.endsWith(`/${drop.pattern}`)) &&
    stamp <= drop.capturedThrough
  );
  return entry === undefined
    ? undefined
    : { paths: new Set(entry.paths), pattern: entry.pattern };
}

/**
 * Every prefix along the way to an accepted path, including the root `""`.
 *
 * This is what keeps the walk from touching state no entry named: a value whose
 * prefix is absent here cannot contain a drop, so it is returned as itself.
 * A `foo[]` segment contributes both `foo` — the key holding the list — and
 * `foo[]`, the level its elements sit at.
 */
function spineOf(paths: ReadonlySet<string>): ReadonlySet<string> {
  const spine = new Set<string>([""]);
  for (const path of paths) {
    let prefix = "";
    for (const segment of path.split(".")) {
      const key = segment.endsWith("[]") ? segment.slice(0, -2) : segment;
      prefix = prefix === "" ? key : `${prefix}.${key}`;
      spine.add(prefix);
      if (key !== segment) {
        prefix = `${prefix}[]`;
        spine.add(prefix);
      }
    }
  }
  return spine;
}

/** A value this walk may rebuild: a bare object literal, nothing else. */
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * `state` with every accepted path removed, and which paths that took.
 *
 * `isReduction` guards the one shape that must never be opened: a reduction
 * stands for something the comparison cannot see through and is compared whole,
 * so the walk returns one untouched rather than descending into its innards.
 * Anything that is not a plain object is returned as-is for the same reason —
 * rebuilding a value whose shape this does not understand would change what the
 * comparison sees.
 *
 * A subtree that lost nothing comes back as ITSELF, not a copy. The state on
 * both sides of the comparison is already `comparableState` output, so a rebuilt
 * copy would compare identically — but "the comparison sees exactly what it was
 * handed" is a property worth holding rather than re-deriving each time someone
 * asks whether the strip is safe.
 *
 * The returned path set is what makes the list shrink. An entry whose paths are
 * nowhere in any vintage forgives nothing, and a gate cannot tell that from an
 * entry quietly doing nothing unless it counts.
 */
export function withoutAcceptedDrops(
  state: unknown,
  paths: ReadonlySet<string>,
  isReduction: (value: unknown) => boolean,
): { value: unknown; applied: Set<string> } {
  const applied = new Set<string>();
  if (paths.size === 0) return { value: state, applied };
  const spine = spineOf(paths);

  const strip = (value: unknown, prefix: string): unknown => {
    if (!spine.has(prefix)) return value;
    if (typeof value !== "object" || value === null) return value;
    if (isReduction(value)) return value;
    if (Array.isArray(value)) {
      const elements = `${prefix}[]`;
      if (!spine.has(elements)) return value;
      let changed = false;
      const out = value.map((element) => {
        const stripped = strip(element, elements);
        if (stripped !== element) changed = true;
        return stripped;
      });
      return changed ? out : value;
    }
    if (!isPlainObject(value)) return value;
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      if (paths.has(path)) {
        applied.add(path);
        changed = true;
        continue;
      }
      const stripped = strip(nested, path);
      if (stripped !== nested) changed = true;
      out[key] = stripped;
    }
    return changed ? out : value;
  };

  return { value: strip(state, ""), applied };
}
