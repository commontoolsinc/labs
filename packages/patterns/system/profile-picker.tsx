import {
  computed,
  ifElse,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import ProfileCreate, {
  profileLinkSchema,
  setDefaultProfile,
  setMruProfile,
  TRUSTED_PROFILE_PICKER_SURFACE,
  TRUSTED_PROFILE_SET_DEFAULT_ACTION,
  TRUSTED_PROFILE_SET_MRU_ACTION,
} from "./profile-create.tsx";
import type { ProfileHomeOutput } from "./profile-home.tsx";

// The profile picker rendered as the `[UI]` of a #profile wish when the user
// has 2+ profiles and no valid default. It renders each profile natively
// (name + avatar + a link), offers an inline "create another" affordance, lets
// the user pick a default, and stamps most-recently-used (MRU) on selection.
//
// The picker is purely the SWITCHING affordance (CT-1829): the wish `.result`
// does NOT flow through this pattern. The wish builtin resolves `.result`
// eagerly to the single best profile — default (if set) ⟶ else MRU head ⟶
// else first (wish.ts getProfileCandidateCells) — in every mode. Selection
// writes MRU and the "set default" control writes `defaultProfile`, both as
// trusted picker-surface actions (owner-protected; see profile-create); those
// writes reorder the builtin's candidates, which is what flips `.result`.
//
// The picker output is only `[UI]` — it does NOT surface a `result` /
// `candidates` (the wish builtin owns those); its former `resultIndex` / `result`
// computeds were vestigial after CT-1829 (#4512) and are removed (CT-1843).

type ProfilePickerInput = {
  profiles: Writable<ProfileHomeOutput[]>;
  defaultProfile: Writable<ProfileHomeOutput | undefined>;
  mru: Writable<ProfileHomeOutput[]>;
};

type WithNormalizedFullLinkReader = {
  getAsNormalizedFullLink?: () => { space?: unknown };
};

type WithSchemaReader<T> = T & {
  asSchema(schema: unknown): { get(): unknown };
};

const asSchemaReader = <T,>(cell: T): WithSchemaReader<T> =>
  cell as WithSchemaReader<T>;

// Whether two profile cells name the SAME profile — compared by the profile's
// own SPACE, NOT by `equals` / entity id (CT-1843; mirrors the runner-side
// `sameProfileCell` in wish.ts landed by CT-1842 #4534).
//
// The `defaultProfile` link and a `profiles`-list entry for the SAME profile
// reach it through DIFFERENT links — different entity `id` (and scope) WITHIN
// that profile's own space (the list stores one cell, the default link another).
// `equals` compares id (and scope), so it returns false cross-space and the
// default badge is mislabeled/omitted. The stable per-profile identity is the
// profile's own SPACE: each profile is a distinct anonymous
// `ProfileHome.inSpace()` whose DID is unique per user and per creation event,
// so equal space ⇒ same profile.
//
// `homeSpace` guards the degenerate case: the `profiles` / `defaultProfile` /
// `mru` container links live in the home space, so an unmaterialized / invalid
// entry that still resolves into the home space must never match.
//
// Uses `getAsNormalizedFullLink().space` when present. A thrown error or
// missing space gives no match.

// A cell's own space DID, or undefined if it isn't a resolvable link. Module
// scope (not pattern context), so optional access keeps unresolved values from
// throwing.
const linkSpace = (cell: unknown): string | undefined => {
  try {
    const space = (cell as WithNormalizedFullLinkReader)
      .getAsNormalizedFullLink?.()?.space;
    return typeof space === "string" ? space : undefined;
  } catch {
    return undefined;
  }
};

const sameProfileCell = (
  a: unknown,
  b: unknown,
  homeSpace: string | undefined,
): boolean => {
  const spaceA = linkSpace(a);
  const spaceB = linkSpace(b);
  if (!spaceA || !spaceB) return false;
  if (spaceA === homeSpace || spaceB === homeSpace) return false;
  return spaceA === spaceB;
};

export default pattern<
  ProfilePickerInput,
  { [UI]: VNode }
>(({ profiles, defaultProfile, mru }) => {
  // Home space of the `profiles`/`defaultProfile`/`mru` container links — used
  // to reject entries that resolve into the home space (see sameProfileCell).
  const homeSpace = linkSpace(profiles);

  const profileCreate = ProfileCreate({
    profiles,
    inputId: "wish-profile-picker-name-input",
  });

  return {
    [NAME]: "Choose a profile",
    [UI]: (
      <cf-vstack
        id="profile-picker"
        gap="2"
        data-ui-pattern={TRUSTED_PROFILE_PICKER_SURFACE}
        data-ui-event-integrity={TRUSTED_PROFILE_PICKER_SURFACE}
        style={{ padding: "8px" }}
      >
        <h3 style={{ margin: 0, fontSize: "14px" }}>Your profiles</h3>
        {profiles.map((p) => (
          <cf-hstack gap="2" align="center">
            <div style={{ flex: "1" }}>
              {
                /* Profiles are identities — rendered via cf-cell-link (the
                  identity idiom is cf-profile-badge), not the generic piece
                  chip variant. */
              }
              <cf-cell-link $cell={p as never} />
            </div>
            {ifElse(
              computed(() => {
                // Read the default link as a cell REF (asCell) so a cross-space
                // profile not yet loaded here doesn't collapse to `undefined`,
                // then match by the profile's own SPACE (CT-1843) — `equals`
                // returns false cross-space (different entity id + scope).
                const def = asSchemaReader(defaultProfile).asSchema(
                  profileLinkSchema(),
                ).get();
                return def ? sameProfileCell(def, p, homeSpace) : false;
              }),
              <span style={{ color: "#0a7", fontSize: "12px" }}>default</span>,
              <cf-button
                size="sm"
                variant="ghost"
                data-ui-action={TRUSTED_PROFILE_SET_DEFAULT_ACTION}
                onClick={setDefaultProfile({
                  defaultProfile: defaultProfile as never,
                  profile: p as never,
                })}
              >
                Set default
              </cf-button>,
            )}
            <cf-button
              size="sm"
              data-ui-action={TRUSTED_PROFILE_SET_MRU_ACTION}
              onClick={setMruProfile({
                mru: mru as never,
                profile: p as never,
              })}
            >
              Use
            </cf-button>
          </cf-hstack>
        ))}
        <hr style={{ border: "none", borderTop: "1px solid #e5e5e7" }} />
        <h4 style={{ margin: 0, fontSize: "12px", color: "#888" }}>
          Add another profile
        </h4>
        {profileCreate}
      </cf-vstack>
    ),
  };
});
