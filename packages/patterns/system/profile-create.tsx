import {
  type Cell,
  Cfc,
  equals,
  handler,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
  WriteAuthorizedBy,
} from "commonfabric";
import ProfileHome, { type ProfileHomeOutput } from "./profile-home.tsx";

// Trusted UI surfaces / actions. The create surface authorizes appending a new
// profile to the home `profiles` list; the picker surface authorizes setting the
// default profile and stamping most-recently-used (MRU).
export const TRUSTED_PROFILE_CREATE_SURFACE = "ProfileCreateSurface";
export const TRUSTED_PROFILE_CREATE_ACTION = "CreateProfile";
export const TRUSTED_PROFILE_PICKER_SURFACE = "ProfilePickerSurface";
export const TRUSTED_PROFILE_SET_DEFAULT_ACTION = "SetDefaultProfile";
export const TRUSTED_PROFILE_SET_MRU_ACTION = "SetMruProfile";

// Read a profile link (or list of links) as cell REFERENCES (`asCell`), not
// inlined values. A plain `.get()` deep-resolves each element and collapses the
// whole read to `undefined` when any element links into a space not yet loaded
// in this context (e.g. a freshly-created profile living in its own `inSpace`
// space). Item type is `unknown` to keep the sync shallow (links only). Mirrors
// wish.ts `profileLinkListSchema`; identity comparisons use `equals` on the
// resulting link cells, which never deep-resolves.
//
// These are functions (not const object literals) so the schema object is built
// per call inside the function body — module-top-level mutable data is rejected
// under SES (`__cf_data()`); a function returning a fresh literal is not.
// deno-lint-ignore no-explicit-any
export const profileLinkListSchema = (): any => ({
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
});
// deno-lint-ignore no-explicit-any
export const profileLinkSchema = (): any => ({
  type: "unknown",
  asCell: ["cell"],
});

export type CreateProfileEvent = {
  detail?: { message?: string };
  key?: string;
  name?: string;
  target?: { value?: string };
};

// Appends a freshly-created profile (its own `inSpace` space) to the home
// `profiles` list. The cross-space `inSpace` child materializes during the push;
// the `.inSpace(...)` call opts the transaction into a multi-space commit (see
// builder/pattern.ts `optIntoInSpaceMultiSpaceCommit` → runner
// `enableCrossSpaceChildCommit`).
//
// CT-1650: the profile space is created via ANONYMOUS `inSpace()` — never
// `inSpace(name)`. A named target derives its DID from
// `fromPassphrase("common user").derive(name)` (createSession spaceName path),
// i.e. the display NAME alone, so two different users picking the same profile
// name — or one user creating two same-named profiles — collide into a single
// shared space. The anonymous case instead derives the DID from this handler's
// frame cause, which carries the creating user's per-home-space input links plus
// the durable per-event id (runner.ts `createPatternFrame` cause): unique per
// user AND per creation event, stable across the cross-space-commit retry. The
// display name flows ONLY to `initialName` (editable later, independent of the
// space identity). Existing profiles keep their already-baked concrete DID link.
export const submitProfileCreation = handler<
  CreateProfileEvent,
  {
    draftName?: Writable<string>;
    profiles: Writable<ProfileHomeOutput[]>;
  }
>((event, { draftName, profiles }) => {
  const name = (event.name ?? event.detail?.message ?? event.target?.value ??
    draftName?.get() ?? "").trim();
  if (name) {
    profiles.push(
      ProfileHome.inSpace()({
        initialName: name,
      }) as ProfileHomeOutput,
    );
    // Clear the draft name input after a successful create (mirrors the form
    // handlers in self.tsx / home's space input).
    draftName?.set("");
  }
});

// Sets the user's default profile — the one `#profile` resolves to in headless
// mode and orders first in the picker. The chosen profile is bound per-row via
// handler state (mirrors how home's removeSpaceHandler binds its item).
export const setDefaultProfile = handler<
  unknown,
  {
    defaultProfile: Writable<ProfileHomeOutput | undefined>;
    // Take the profile as a LINK cell, not a resolved value: the handler only
    // needs the link to write into defaultProfile, and a link argument doesn't
    // require the profile's cross-space values to be loaded at event time —
    // resolving the full value here would fail required-field validation
    // ("stream action argument is undefined … not running") whenever the
    // profile's space hasn't materialized locally yet.
    profile: Cell<ProfileHomeOutput>;
  }
>((_, { defaultProfile, profile }) => {
  if (profile) {
    defaultProfile.set(profile as any);
  }
});

// Stamps a profile as most-recently-used: prepend to the MRU list (deduped by
// link identity). Drives the picker's "default first, then by MRU" ordering.
export const setMruProfile = handler<
  unknown,
  {
    mru: Writable<ProfileHomeOutput[]>;
    // Link cell, not a resolved value — same event-time-validation reason as
    // setDefaultProfile above.
    profile: Cell<ProfileHomeOutput>;
  }
>((_, { mru, profile }) => {
  if (!profile) return;
  // Read existing entries as link cells (not inlined values) so an entry that
  // links into an unloaded space doesn't collapse the whole read to `undefined`
  // and silently wipe MRU history. Dedup by link identity via `equals`.
  const current = ((mru as any).asSchema(profileLinkListSchema()).get() ??
    []) as ProfileHomeOutput[];
  const filtered = current.filter((entry) => !equals(entry, profile));
  mru.set([profile, ...filtered] as any);
});

// A single owner-protected link to a profile pattern in its own space, created
// through the trusted create surface. This element contract gates adding or
// replacing a link (a changed element value); the array container additionally
// carries `writeAuthorizedBy` to gate structural changes (see TrustedProfileList
// below).
export type TrustedProfileLink = Cfc<
  WriteAuthorizedBy<Cell<ProfileHomeOutput>, typeof submitProfileCreation>,
  {
    addIntegrity: ["profile-link"];
    uiContract: {
      helper: "UiAction";
      action: typeof TRUSTED_PROFILE_CREATE_ACTION;
      trustedPattern: typeof TRUSTED_PROFILE_CREATE_SURFACE;
      requiredEventIntegrity: [typeof TRUSTED_PROFILE_CREATE_SURFACE];
    };
  }
>;

// The home `profiles` list. Protection is two-layered:
//   - elements (`TrustedProfileLink`) carry the create `uiContract` — gates
//     adding/replacing a link (a changed element value) to the trusted surface;
//   - the array container carries `writeAuthorizedBy: submitProfileCreation` —
//     gates STRUCTURAL changes (truncation / removal / reorder) that the
//     element-wildcard contract misses, because CFC's element-applies check only
//     visits *changed* elements of the new array, so a `set([])` or shrink would
//     otherwise be unmediated. Container `writeAuthorizedBy` (identity-based)
//     rather than `uiContract` (per-event) so a legit append — which also
//     rewrites the container — passes under the create handler's identity
//     instead of re-triggering a per-event trusted requirement it can't satisfy.
export type TrustedProfileList = Cfc<
  WriteAuthorizedBy<TrustedProfileLink[], typeof submitProfileCreation>,
  { addIntegrity: ["profile-link"] }
>;

// A profile link written via the trusted picker surface (default / MRU writes).
type PickerProfileLink<Binding, Action extends string> = Cfc<
  WriteAuthorizedBy<Cell<ProfileHomeOutput>, Binding>,
  {
    addIntegrity: ["profile-link"];
    uiContract: {
      helper: "UiAction";
      action: Action;
      trustedPattern: typeof TRUSTED_PROFILE_PICKER_SURFACE;
      requiredEventIntegrity: [typeof TRUSTED_PROFILE_PICKER_SURFACE];
    };
  }
>;

// The home `defaultProfile` link: write authorized by `setDefaultProfile`.
export type TrustedDefaultProfile =
  | PickerProfileLink<
    typeof setDefaultProfile,
    typeof TRUSTED_PROFILE_SET_DEFAULT_ACTION
  >
  | undefined;

// The home `mru` list: elements carry the picker `uiContract`; the array
// container carries `writeAuthorizedBy: setMruProfile` to gate structural
// changes (truncation/removal), same two-layer rationale as TrustedProfileList.
export type TrustedProfileMru = Cfc<
  WriteAuthorizedBy<
    PickerProfileLink<
      typeof setMruProfile,
      typeof TRUSTED_PROFILE_SET_MRU_ACTION
    >[],
    typeof setMruProfile
  >,
  { addIntegrity: ["profile-link"] }
>;

export type ProfileCreateInput = {
  profiles: Writable<ProfileHomeOutput[]>;
  inputId?: string;
  buttonId?: string;
};

export type ProfileCreateOutput = {
  [NAME]: string;
  [UI]: VNode;
  createProfile: Stream<CreateProfileEvent>;
};

export default pattern<ProfileCreateInput, ProfileCreateOutput>(
  ({ profiles, inputId, buttonId }) => {
    const draftName = new Writable("").for("draftName");
    const createProfile = submitProfileCreation({
      draftName,
      profiles: profiles as any,
    });
    return {
      [NAME]: "Create Profile",
      createProfile,
      [UI]: (
        <cf-vstack
          id="profile-create-surface"
          data-ui-pattern={TRUSTED_PROFILE_CREATE_SURFACE}
          data-ui-event-integrity={TRUSTED_PROFILE_CREATE_SURFACE}
          gap="1"
        >
          <cf-input
            id={inputId ?? "profile-name-input"}
            $value={draftName}
            placeholder="Your name..."
            timingStrategy="immediate"
          />
          <cf-button
            id={buttonId ?? "profile-create-button"}
            data-ui-action={TRUSTED_PROFILE_CREATE_ACTION}
            onClick={createProfile}
          >
            Create profile
          </cf-button>
        </cf-vstack>
      ),
    };
  },
);
