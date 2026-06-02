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

export type CreateProfileEvent = {
  detail?: { message?: string };
  key?: string;
  name?: string;
  target?: { value?: string };
};

// Appends a freshly-created profile (its own `inSpace` space) to the home
// `profiles` list. The cross-space `inSpace` child materializes during the push;
// the runner opts the transaction into a multi-space commit (see
// data-updating.ts / enableCrossSpaceChildCommit).
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
      ProfileHome.inSpace(name)({
        initialName: name,
      }) as ProfileHomeOutput,
    );
  }
});

// Sets the user's default profile — the one `#profile` resolves to in headless
// mode and orders first in the picker. The chosen profile is bound per-row via
// handler state (mirrors how home's removeSpaceHandler binds its item).
export const setDefaultProfile = handler<
  unknown,
  {
    defaultProfile: Writable<ProfileHomeOutput | undefined>;
    profile: ProfileHomeOutput;
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
    profile: ProfileHomeOutput;
  }
>((_, { mru, profile }) => {
  if (!profile) return;
  const current = mru.get() ?? [];
  const filtered = current.filter((entry) => !equals(entry, profile));
  mru.set([profile, ...filtered] as any);
});

// A single owner-protected link to a profile pattern in its own space, created
// through the trusted create surface. The owner-protection lives on the element
// (not just the array container) because CFC's `writeAuthorizedBy` gate applies
// to value/object writes — writing an array element must itself be authorized.
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

// The home `profiles` list: both the array and its elements are append-gated by
// `submitProfileCreation` behind the trusted create surface/action.
export type TrustedProfileList = Cfc<
  WriteAuthorizedBy<TrustedProfileLink[], typeof submitProfileCreation>,
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

// The home `mru` list: both the array and its elements are write-gated by
// `setMruProfile` behind the trusted picker surface/action.
export type TrustedProfileMru = Cfc<
  WriteAuthorizedBy<
    PickerProfileLink<
      typeof setMruProfile,
      typeof TRUSTED_PROFILE_SET_MRU_ACTION
    >[],
    typeof setMruProfile
  >,
  {
    addIntegrity: ["profile-link"];
    uiContract: {
      helper: "UiAction";
      action: typeof TRUSTED_PROFILE_SET_MRU_ACTION;
      trustedPattern: typeof TRUSTED_PROFILE_PICKER_SURFACE;
      requiredEventIntegrity: [typeof TRUSTED_PROFILE_PICKER_SURFACE];
    };
  }
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
