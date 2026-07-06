import {
  computed,
  equals,
  ifElse,
  NAME,
  pattern,
  UI,
  type VNode,
  type WishState,
  Writable,
} from "commonfabric";
import ProfileCreate, {
  type DefaultProfileCell,
  profileLinkListSchema,
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
// The `resultIndex`/`result` computeds below duplicate the builtin's ordering
// and are VESTIGIAL — nothing reads them anymore; kept one release for
// compatibility, then to be deleted (CT-1829 follow-up).

type ProfilePickerInput = {
  profiles: Writable<ProfileHomeOutput[]>;
  // CT-1845: OPAQUE `DefaultProfileCell`, never `Writable<ProfileHomeOutput |
  // undefined>`. CFC derives the walked write-authorization schema from the
  // binding site, and this input type flows into the `setDefaultProfile` write
  // below (`defaultProfile: defaultProfile as any`). A walkable
  // `ProfileHomeOutput` here re-introduces the owner-protected `/avatar` walk
  // that fails the overwrite. See profile-create.tsx.
  defaultProfile: DefaultProfileCell;
  mru: Writable<ProfileHomeOutput[]>;
};

export default pattern<
  ProfilePickerInput,
  WishState<ProfileHomeOutput> & { [UI]: VNode }
>(({ profiles, defaultProfile, mru }) => {
  // Index (into `profiles`) of the profile the wish should resolve to.
  // Reads links as cell refs (asCell) and matches by link identity via `equals`,
  // so a cross-space profile not yet loaded here doesn't collapse the read to
  // `undefined` (which would mis-resolve to index 0). See profileLinkSchema.
  const resultIndex = computed(() => {
    const list = ((profiles as any).asSchema(profileLinkListSchema()).get() ??
      []) as ProfileHomeOutput[];
    if (list.length === 0) return -1;
    const def = (defaultProfile as any).asSchema(profileLinkSchema()).get() as
      | ProfileHomeOutput
      | undefined;
    const mruList = ((mru as any).asSchema(profileLinkListSchema()).get() ??
      []) as ProfileHomeOutput[];
    const matchIndex = (target: ProfileHomeOutput | undefined) =>
      target ? list.findIndex((entry) => equals(entry, target)) : -1;

    // Default wins (matches headless #profile), then most-recently-used.
    const defIdx = matchIndex(def);
    if (defIdx >= 0) return defIdx;
    const mruIdx = mruList.length > 0 ? matchIndex(mruList[0]) : -1;
    if (mruIdx >= 0) return mruIdx;
    return 0;
  });

  // Named computed so the CTS transformer leaves it intact in the return object
  // and wish.ts can read the resolved profile via `.get()`.
  const result = computed(() => {
    const idx = resultIndex;
    return idx >= 0 ? (profiles.key(idx) as any) : undefined;
  });

  const profileCreate = ProfileCreate({
    profiles: profiles as any,
    inputId: "wish-profile-picker-name-input",
  });

  return {
    [NAME]: "Choose a profile",
    result,
    candidates: profiles as any,
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
              <cf-cell-link $cell={p as any} />
            </div>
            {ifElse(
              computed(() => {
                const def = (defaultProfile as any).asSchema(
                  profileLinkSchema(),
                ).get();
                return def ? equals(def, p) : false;
              }),
              <span style={{ color: "#0a7", fontSize: "12px" }}>default</span>,
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
            )}
            <cf-button
              size="sm"
              data-ui-action={TRUSTED_PROFILE_SET_MRU_ACTION}
              onClick={setMruProfile({ mru: mru as any, profile: p })}
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
