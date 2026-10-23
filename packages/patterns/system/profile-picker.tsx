import {
  type Cell,
  computed,
  type Default,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import ProfileCreate, {
  type DefaultProfileSlot,
  defaultProfileSpace,
  liveProfileSpaces,
  restoreProfile,
  retireProfile,
  setDefaultProfile,
  setMruProfile,
  TRUSTED_PROFILE_PICKER_SURFACE,
  TRUSTED_PROFILE_SET_DEFAULT_ACTION,
  TRUSTED_PROFILE_SET_MRU_ACTION,
} from "./profile-create.tsx";
import type {
  BackwardsCompatibleProfile,
  ProfileInbox,
} from "./profile-home.tsx";
import { profileLinks, profileLinkSpace } from "./profile-links.ts";

// The profile picker rendered as the `[UI]` of a #profile wish when the user
// has 2+ profiles and no valid default. It renders each profile natively
// (name + avatar + a link), offers an inline "create another" affordance, lets
// the user pick a default, stamps most-recently-used (MRU) on selection, and
// retires a profile through Remove, which asks to confirm first. Remove is
// offered on every row but the one `retireProfile` refuses: the profile
// `#profile` returns. Retired profiles are listed apart, each with a Restore.
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

// `defaultProfile` is home's slot, which "Set default" writes. A home without
// one holds its default only as `legacyDefaultProfile`, a link at the root of
// its `defaultProfile` cell; the picker is then handed no slot and
// `offersSetDefault: false`, since a write through that cell would land in the
// linked profile. The default is the slot's `profile`, or
// `legacyDefaultProfile` while the slot holds none.
type ProfilePickerInput = {
  profiles: Writable<BackwardsCompatibleProfile[]>;
  defaultProfile?: Writable<DefaultProfileSlot>;
  legacyDefaultProfile?: Writable<BackwardsCompatibleProfile | undefined>;
  offersSetDefault: Default<boolean, true>;
  mru: Writable<BackwardsCompatibleProfile[]>;
  // Home's retired profiles, which the picker lists apart, its Remove
  // appends to through `retireProfile`, and its Restore removes from through
  // `restoreProfile`.
  // Defaulted, as an input a stored picker's argument may lack; absent, the
  // picker lists no profile as retired.
  retiredProfiles?: Writable<Default<BackwardsCompatibleProfile[], []>>;
  // Home's private inbox, which a profile created here is pointed at; see
  // `ProfileCreateInput.privateInbox`.
  privateInbox?: ProfileInbox;
};

// Whether two profile cells name the SAME profile — compared by the profile's
// own SPACE, NOT by `equals` / entity id (CT-1843; mirrors the runner-side
// `sameProfileCell` in wish.ts landed by CT-1842 #4534).
//
// The default's link (`defaultProfile.profile`) and a `profiles`-list entry for
// the SAME profile reach it through DIFFERENT links — different entity `id`
// (and scope) WITHIN that profile's own space (the list stores one cell, the
// default link another).
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
// Both sides must be link CELLS: the default read as a cell ref, and the row's
// profile re-read from the `profiles` list by index. The map callback's element
// parameter is not usable for this — inside a `computed` it is the opaque
// reference, not a cell, so it carries no link and every row compared as "not
// the default" (the badge never lit; 2026-09-11, the estuary profile preflight).
//
// The spaces are read with `profileLinkSpace()`. Any throw or missing space
// means no match.
const sameProfileCell = (
  a: unknown,
  b: unknown,
  homeSpace: string | undefined,
): boolean => {
  const spaceA = profileLinkSpace(a);
  const spaceB = profileLinkSpace(b);
  if (!spaceA || !spaceB) return false;
  if (spaceA === homeSpace || spaceB === homeSpace) return false;
  return spaceA === spaceB;
};

// Whether `entry` names a profile in `retired`, compared by space.
const isRetired = (
  entry: unknown,
  retired: readonly unknown[],
  homeSpace: string | undefined,
): boolean => retired.some((each) => sameProfileCell(each, entry, homeSpace));

// Asks to confirm the retirement of a row's profile, or, with no profile
// bound, withdraws the question: records which profile, by its space, the
// confirmation is showing for. Remove asks first so that a stray click retires
// nothing.
const askToRetire = handler<
  unknown,
  { confirming: Writable<string>; profile?: Cell<BackwardsCompatibleProfile> }
>((_, { confirming, profile }) => {
  confirming.set(profile === undefined ? "" : profileLinkSpace(profile) ?? "");
});

export default pattern<
  ProfilePickerInput,
  { [UI]: VNode }
>((
  {
    profiles,
    defaultProfile,
    legacyDefaultProfile,
    offersSetDefault,
    mru,
    retiredProfiles,
    privateInbox,
  },
) => {
  // Home space of the `profiles`/`defaultProfile`/`mru` container links — used
  // to reject entries that resolve into the home space (see sameProfileCell).
  const homeSpace = profileLinkSpace(profiles);

  const profileCreate = ProfileCreate({
    profiles: profiles as any,
    inputId: "wish-profile-picker-name-input",
    privateInbox,
  });

  // The space of the profile whose Remove is awaiting confirmation, or "".
  // Per session: an unanswered question belongs to the view that asked it,
  // not to Home, so it neither outlives the session nor reaches another
  // device.
  const confirming = Writable.perSession.of<string>("");

  // Named, so the rows' documents are keyed by `profileRows` rather than by
  // the map's position among the picker's nodes. A retired profile's row is
  // empty.
  const profileRows = profiles.map((p, i) => {
    // Whether this row's profile is the default, matched by the profile's
    // own SPACE (CT-1843): the default's link and this row's list entry name
    // the same profile through different documents. The entry comes from the
    // list by index, read as a link, not from `p`: see sameProfileCell.
    const isDefault = computed(() => {
      const space = profileLinkSpace(profileLinks(profiles)[i]);
      return space !== undefined && space !== homeSpace &&
        space === defaultProfileSpace(
            defaultProfile,
            legacyDefaultProfile,
            homeSpace,
          );
    });
    // Whether this row's profile is the one `#profile` returns, which
    // `retireProfile` refuses to retire.
    const isAnswering = computed(() => {
      const space = profileLinkSpace(profileLinks(profiles)[i]);
      return space !== undefined &&
        space === liveProfileSpaces({
            profiles,
            defaultProfile,
            legacyDefaultProfile,
            mru,
            retiredProfiles,
          }, homeSpace)[0];
    });
    return ifElse(
      computed(() =>
        isRetired(
          profileLinks(profiles)[i],
          profileLinks(retiredProfiles),
          homeSpace,
        )
      ),
      null,
      <cf-vstack gap="1">
        <cf-hstack gap="2" align="center">
          <div style={{ flex: "1" }}>
            {
              /* Profiles are identities — rendered via cf-cell-link (the
              identity idiom is cf-profile-badge), not the generic piece
              chip variant. */
            }
            <cf-cell-link $cell={p as any} />
          </div>
          {ifElse(
            isDefault,
            <span style={{ color: "#0a7", fontSize: "12px" }}>default</span>,
            ifElse(
              offersSetDefault,
              <cf-button
                size="sm"
                variant="ghost"
                data-ui-action={TRUSTED_PROFILE_SET_DEFAULT_ACTION}
                onClick={setDefaultProfile({
                  defaultProfile: defaultProfile as any,
                  profile: p,
                })}
              >
                Set default
              </cf-button>,
              null,
            ),
          )}
          <cf-button
            size="sm"
            data-ui-action={TRUSTED_PROFILE_SET_MRU_ACTION}
            onClick={setMruProfile({ mru: mru as any, profile: p })}
          >
            Use
          </cf-button>
          {
            /* The profile `#profile` returns has no Remove: retiring it
              would move `#profile` to another profile, so another default
              is chosen first. */
          }
          {ifElse(
            isAnswering,
            null,
            <cf-button
              size="sm"
              variant="ghost"
              onClick={askToRetire({ confirming, profile: p })}
            >
              Remove…
            </cf-button>,
          )}
        </cf-hstack>
        {ifElse(
          computed(() => {
            const space = profileLinkSpace(profileLinks(profiles)[i]);
            return space !== undefined && confirming.get() === space;
          }),
          <cf-hstack gap="2" align="center">
            <span style={{ flex: "1", fontSize: "12px" }}>
              Remove this profile? It stops being one of your profiles, though
              places that link to it still show it. You can restore it later
              from the list of removed profiles below.
            </span>
            <cf-button
              size="sm"
              color="danger"
              onClick={retireProfile({
                profiles,
                mru,
                retiredProfiles: retiredProfiles as any,
                defaultProfile: defaultProfile as any,
                legacyDefaultProfile: legacyDefaultProfile as any,
                profile: p,
              })}
            >
              Remove profile
            </cf-button>
            <cf-button
              size="sm"
              variant="ghost"
              onClick={askToRetire({ confirming })}
            >
              Cancel
            </cf-button>
          </cf-hstack>,
          null,
        )}
      </cf-vstack>,
    );
  });

  // The retired profiles, each with a Restore that makes it one of the
  // user's profiles again.
  const retiredRows = retiredProfiles.map((p) => (
    <cf-hstack gap="2" align="center">
      <div style={{ flex: "1" }}>
        <cf-cell-link $cell={p as any} />
      </div>
      <cf-button
        size="sm"
        variant="ghost"
        onClick={restoreProfile({
          retiredProfiles: retiredProfiles as any,
          profile: p,
        })}
      >
        Restore
      </cf-button>
    </cf-hstack>
  ));

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
        {profileRows}
        {ifElse(
          computed(() => profileLinks(retiredProfiles).length > 0),
          <cf-vstack gap="1">
            <h4 style={{ margin: 0, fontSize: "12px", color: "#888" }}>
              Removed profiles
            </h4>
            {retiredRows}
          </cf-vstack>,
          null,
        )}
        <hr style={{ border: "none", borderTop: "1px solid #e5e5e7" }} />
        <h4 style={{ margin: 0, fontSize: "12px", color: "#888" }}>
          Add another profile
        </h4>
        {profileCreate}
      </cf-vstack>
    ),
  };
});
