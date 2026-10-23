/**
 * The order in which a user's profiles answer `#profile`: the default first,
 * then the most recently used, then the order of the home `profiles` list.
 * A profile the home lists in `retiredProfiles` is not one of the user's
 * profiles, and is left out.
 * The `wish` builtin decides `#profile` by it, and the host decides by it which
 * profile's inbox pointer Home's private inbox follows. Everything here but
 * `loadProfileCandidates()` reads only what is already loaded, and that
 * function loads it, for a caller outside a reactive run.
 */

import { internSchema } from "@commonfabric/data-model-schema";
import { isObjectOrArray } from "@commonfabric/utils/types";
import { attestedPrincipalsAt } from "./builder/principal-of.ts";
import type { Cell } from "./cell.ts";
import { loadDocument } from "./document-readiness.ts";
import { isPrimitiveCellLink, parseLink } from "./link-utils.ts";
import type { Runtime } from "./runtime.ts";
import type { IExtendedStorageTransaction } from "./storage/interface.ts";

/**
 * Schema for a list of profile links, the home `profiles` and `mru` lists, each
 * element read as a link to the profile rather than as its value.
 */
// Each element is read as a cell *reference* (`asCell`), NOT its inlined value,
// so the list can be enumerated without deep-resolving every profile's own
// space. A plain `.get()` inlines each element and returns `undefined` for the
// whole list whenever any element is a link into a space not yet loaded in the
// reading context — e.g. a shared piece resolving `#profile` right after a
// profile was created in its own (`inSpace`) space. That would collapse the
// list to length 0 and hide the just-created profile behind the "No profile" /
// create surface.
//
// The item type is `unknown` (not `object`) on purpose: with `asCell`, an
// `object` item schema would trigger a *deep* sync of each linked profile —
// fetching its entire object graph and everything it transitively links, across
// space boundaries — just to count the list. `unknown` keeps the sync shallow
// (we only need the links here).
export const profileLinkListSchema = internSchema(
  {
    type: "array",
    items: { type: "unknown", asCell: ["cell"] },
  },
);

/**
 * A profile link is valid when it resolves to a cell in another space (the
 * profile's own `inSpace` space) with an empty path. An unset link, or one that
 * still points into the home space, means the profile does not exist yet.
 */
export function profileCellIsValid(
  cell: Cell<unknown>,
  rawIsSet: boolean,
  homeSpace: Cell<unknown>["space"],
): boolean {
  if (!rawIsSet) return false;
  const link = cell.getAsNormalizedFullLink();
  return link.space !== homeSpace && link.path.length === 0;
}

/**
 * Whether home `defaultPattern` keeps its default in a slot: whether its
 * `defaultProfile` holds an object at its root, read in the cell the field
 * names rather than through it. A home without the slot keeps its default as a
 * link at the root of that cell, or has nothing there; one with the slot keeps
 * such a link, chosen before the slot, as `legacyDefaultProfile`.
 */
export function homeHasDefaultProfileSlot(
  runtime: Runtime,
  defaultPattern: Cell<unknown>,
  tx: IExtendedStorageTransaction | undefined,
): boolean {
  const field = defaultPattern.key("defaultProfile");
  const fieldRaw = field.getRaw();
  const root = isPrimitiveCellLink(fieldRaw)
    ? runtime.getCellFromLink(parseLink(fieldRaw, field), undefined, tx)
      .getRaw()
    : fieldRaw;
  return isObjectOrArray(root) && !Array.isArray(root) &&
    !isPrimitiveCellLink(root);
}

/**
 * Whether a `mru` / `defaultProfile` entry names the SAME profile as a candidate
 * from the home `profiles` list — compared by the profile's own SPACE, NOT by
 * `Cell.equals` or by entity id.
 *
 * CT-1842: the `#profile` ordering matches candidates (from `profiles`) against
 * the `defaultProfile` link and the `mru` list. Those name the same profiles but
 * reach them through DIFFERENT links. Two distinct differences defeat a naive
 * comparison, both observed on live data:
 *   - `scope` skew — `Cell.equals` (`areNormalizedLinksSame`) compares `scope`,
 *     which the two sides don't always agree on; and
 *   - DIFFERENT entity `id` — the `mru`/`defaultProfile` link and the `profiles`
 *     link for the SAME profile point at different cells WITHIN that profile's
 *     space (e.g. the picker stores the profile pattern's result cell while the
 *     list stores the pattern cell). So even id+space+path comparison fails.
 *
 * The stable per-profile identity is the profile's own SPACE. Each profile is a
 * distinct anonymous `ProfileHome.inSpace()` (see submitProfileCreation), whose
 * DID is unique per user AND per creation event, and `profileCellIsValid`
 * guarantees every valid candidate lives in its OWN non-home space. No two
 * distinct valid profiles ever share a space, so equal space ⇒ same profile.
 * Reading each cell's normalized link keeps the ordering reactive to
 * `mru`/`defaultProfile` changes.
 *
 * `homeSpace` guards the degenerate case: a `mru`/`defaultProfile` entry that
 * still resolves into the home space (an unmaterialized / invalid link) must
 * never match — candidates are never in the home space, but the guard makes the
 * intent explicit and defends against a future home-space candidate slipping in.
 */
export function sameProfileCell(
  a: Cell<unknown>,
  b: Cell<unknown>,
  homeSpace: Cell<unknown>["space"],
): boolean {
  const spaceA = a.getAsNormalizedFullLink().space;
  const spaceB = b.getAsNormalizedFullLink().space;
  if (spaceA === homeSpace || spaceB === homeSpace) return false;
  return spaceA === spaceB;
}

/**
 * The fields of a home, besides `profiles`, that {@link orderProfileCandidates}
 * reads, each a link to a document of its own that a caller loads before
 * ordering.
 */
export const PROFILE_ORDER_FIELDS = [
  "defaultProfile",
  "legacyDefaultProfile",
  "mru",
  "retiredProfiles",
] as const;

/** A link read as the cell it names, one link deep. */
const linkSchema = internSchema({ type: "unknown", asCell: ["cell"] });

/**
 * The documents the home `defaultPattern` holds `profiles` and
 * {@link PROFILE_ORDER_FIELDS} in: for each field, the document its link
 * names, read one link deep, so that a field holding a link to a profile
 * names the document that holds the link rather than the profile. Ordering
 * without one of these could put another profile first, so a caller treats
 * a failure to load one as a failure, not as an absence.
 */
export function profileOrderDocuments(
  defaultPattern: Cell<unknown>,
): Cell<unknown>[] {
  return ["profiles", ...PROFILE_ORDER_FIELDS].flatMap((field) => {
    const document = defaultPattern.key(field).asSchema(linkSchema).get();
    return document === undefined ? [] : [document];
  });
}

/** The profiles the home `defaultPattern` lists in `retiredProfiles`. */
export function retiredProfileCells(
  defaultPattern: Cell<unknown>,
): Cell<unknown>[] {
  const retiredCell = defaultPattern.key("retiredProfiles");
  const raw = retiredCell.asSchema(profileLinkListSchema).get();
  const length = Array.isArray(raw) ? raw.length : 0;
  return Array.from(
    { length },
    (_, index) => retiredCell.key(index).resolveAsCell(),
  );
}

/**
 * Whether `candidate` is one of `retired`, the profiles a home retired,
 * matched by its own space as {@link sameProfileCell} says.
 */
export function profileIsRetired(
  retired: readonly Cell<unknown>[],
  candidate: Cell<unknown>,
  homeSpace: Cell<unknown>["space"],
): boolean {
  return retired.some((each) => sameProfileCell(each, candidate, homeSpace));
}

/**
 * What the label on the value of a profile's `name` says of whose profile it
 * is, for the person whose profiles Home lists: `own` when it attests that
 * person, and no one else, as the principal the name represents; `unattested`
 * when it attests no one, as a name stored before names were labeled does, or
 * one whose document is absent; and `foreign` for any other label.
 */
export type ProfileOwnership = "own" | "unattested" | "foreign";

/**
 * Whose `profile`, a profile Home lists, is, for `owner`, the DID of the
 * person whose Home it is (`ProfileOwnership`). This is the one rule every
 * reader of which profiles are the person's applies. What reads `own` as
 * the person's and nothing else: the `cf profile` commands, and Home's
 * record of the profile acting in a social space, which pattern code decides
 * by the same label with `principalsOf()`. What refuses only `foreign`,
 * keeping a profile whose name carries no label, as a name stored before
 * names were labeled does: `#profile`, a runtime's preferred profile, and the
 * guard Home's `retireProfile` keeps on the profile `#profile` returns
 * (`liveProfileSpaces()`). The label is read as
 * `principalOf()` reads it (`attestedPrincipalsAt()`), through `tx`, on the
 * document the `name` value resolves to, which the caller has loaded: the
 * label of the document holding the field says whom the field was installed
 * for, and only the value's own says whose word the name is.
 *
 * @throws When the label is stored in a form this build cannot interpret, or
 *   the transaction's read of it fails.
 */
export function profileOwnership(
  profile: Cell<unknown>,
  owner: string,
  tx: IExtendedStorageTransaction,
): ProfileOwnership {
  const name = profile.withTx(tx).key("name").resolveAsCell()
    .getAsNormalizedFullLink();
  const principals = attestedPrincipalsAt(tx, name, "represents-principal");
  return principals === undefined
    ? "foreign"
    : principals.length === 0
    ? "unattested"
    : principals.length === 1 && principals[0] === owner
    ? "own"
    : "foreign";
}

/** The candidates in `#profile` order, and what decided it. */
export type ProfileOrder = {
  /**
   * The candidates that are not retired, default first, then by MRU rank,
   * then in list order.
   */
  ordered: Cell<unknown>[];

  /**
   * Whether the home names a default profile that is a valid link and is
   * not retired.
   */
  defaultValid: boolean;

  /** The default profile's cell, meaningful only while `defaultValid`. */
  defaultCell: Cell<unknown>;

  /** The MRU list's entries, most recent first. */
  mruCells: Cell<unknown>[];
};

/**
 * Orders `candidates`, the valid profiles of the home `defaultPattern` in list
 * order, as `#profile` answers, leaving out those it retired: the default
 * first, then by rank in the MRU list, then in list order. The default is
 * the link under `profile` in the home's slot, or, while the slot holds none,
 * the link a home keeps an earlier default in: `legacyDefaultProfile`, or
 * `defaultProfile` itself for a home without the slot. A retired default is
 * no default. Profiles are matched by their own space, as
 * {@link sameProfileCell} says. `homeSpace` is the home space's DID.
 */
export function orderProfileCandidates(
  runtime: Runtime,
  defaultPattern: Cell<unknown>,
  homeSpace: Cell<unknown>["space"],
  candidates: readonly Cell<unknown>[],
  tx?: IExtendedStorageTransaction,
): ProfileOrder {
  const hasSlot = homeHasDefaultProfileSlot(runtime, defaultPattern, tx);
  const slotEntry = defaultPattern.key("defaultProfile").key("profile");
  const slotCell = slotEntry.resolveAsCell();
  const slotValid = hasSlot &&
    profileCellIsValid(slotCell, slotEntry.getRaw() !== undefined, homeSpace);
  const legacyEntry = defaultPattern.key(
    hasSlot ? "legacyDefaultProfile" : "defaultProfile",
  );
  const defaultCell = slotValid ? slotCell : legacyEntry.resolveAsCell();
  const retired = retiredProfileCells(defaultPattern);
  const defaultValid = (slotValid ||
    profileCellIsValid(
      defaultCell,
      legacyEntry.getRaw() !== undefined,
      homeSpace,
    )) && !profileIsRetired(retired, defaultCell, homeSpace);

  const mruCell = defaultPattern.key("mru");
  const mruRaw = mruCell.asSchema(profileLinkListSchema).get();
  const mruLength = Array.isArray(mruRaw) ? mruRaw.length : 0;
  const mruCells: Cell<unknown>[] = [];
  for (let j = 0; j < mruLength; j++) {
    mruCells.push(mruCell.key(j).resolveAsCell());
  }
  const mruRank = (cell: Cell<unknown>): number => {
    const idx = mruCells.findIndex((m) => sameProfileCell(m, cell, homeSpace));
    return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
  };

  const ordered = candidates.filter((candidate) =>
    !profileIsRetired(retired, candidate, homeSpace)
  );
  ordered.sort((a, b) => {
    if (defaultValid) {
      const aDef = sameProfileCell(defaultCell, a, homeSpace);
      const bDef = sameProfileCell(defaultCell, b, homeSpace);
      if (aDef && !bDef) return -1;
      if (bDef && !aDef) return 1;
    }
    return mruRank(a) - mruRank(b);
  });
  return { ordered, defaultValid, defaultCell, mruCells };
}

/**
 * Loads what ordering the profiles of the home `defaultPattern` reads
 * ({@link profileOrderDocuments}), and returns the candidates
 * {@link orderProfileCandidates} takes: the valid
 * profiles of its `profiles` list, in list order, as `#profile` collects
 * them. A retired profile is left out before its document is loaded, one
 * whose document is absent is left out, and so is one whose name is attested
 * to someone else (`profileOwnership()` returns `foreign`). One whose document, or the document
 * its `name` resolves to, failed to load is a candidate, with its failure in
 * `failures`, so that a failure never changes which profile is first. The caller passes a freshly read
 * `defaultPattern`, since a handle read before a change, a retire among
 * them, keeps returning what it held then.
 *
 * @throws DocumentLoadError when the home's root, or a document ordering
 * reads, fails to load.
 */
export async function loadProfileCandidates(
  runtime: Runtime,
  defaultPattern: Cell<unknown>,
): Promise<{
  candidates: Cell<unknown>[];
  failures: Map<Cell<unknown>, unknown>;
}> {
  await loadDocument(runtime, defaultPattern);
  await Promise.all(
    profileOrderDocuments(defaultPattern).map((document) =>
      loadDocument(runtime, document)
    ),
  );
  const homeSpace = defaultPattern.space;
  const retired = retiredProfileCells(defaultPattern);
  const listed = defaultPattern.key("profiles");
  const raw = listed.asSchema(profileLinkListSchema).get();
  const length = Array.isArray(raw) ? raw.length : 0;
  const failures = new Map<Cell<unknown>, unknown>();
  const loaded = await Promise.all(
    Array.from({ length }, async (_, index) => {
      const entry = listed.key(index);
      const profile = entry.resolveAsCell();
      if (
        !profileCellIsValid(profile, entry.getRaw() !== undefined, homeSpace) ||
        profileIsRetired(retired, profile, homeSpace)
      ) {
        return undefined;
      }
      try {
        if (!await loadDocument(runtime, profile)) return undefined;
        await loadDocument(runtime, profile.key("name").resolveAsCell());
      } catch (error) {
        failures.set(profile, error);
        return profile;
      }
      const tx = runtime.edit();
      try {
        return profileOwnership(profile, homeSpace, tx) === "foreign"
          ? undefined
          : profile;
      } finally {
        tx.abort();
      }
    }),
  );
  return {
    candidates: loaded.filter((each) => each !== undefined),
    failures,
  };
}

/**
 * `ordered` with the profile whose space is `space` moved first, the rest
 * keeping their order (`RuntimeOptions.preferredProfileSpace`), or
 * `undefined` when none of them lives in `space`.
 */
export function preferProfile(
  ordered: readonly Cell<unknown>[],
  space: Cell<unknown>["space"],
): Cell<unknown>[] | undefined {
  const index = ordered.findIndex((cell) =>
    cell.getAsNormalizedFullLink().space === space
  );
  return index === -1
    ? undefined
    : [ordered[index], ...ordered.slice(0, index), ...ordered.slice(index + 1)];
}
