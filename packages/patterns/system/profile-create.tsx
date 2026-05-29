import {
  type Cell,
  Cfc,
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

export const TRUSTED_PROFILE_CREATE_SURFACE = "ProfileCreateSurface";
export const TRUSTED_PROFILE_CREATE_ACTION = "CreateProfile";

export type CreateProfileEvent = {
  detail?: { message?: string };
  key?: string;
  name?: string;
  target?: { value?: string };
};

export const submitProfileCreation = handler<
  CreateProfileEvent,
  {
    draftName?: Writable<string>;
    profile: Cell<ProfileHomeOutput>;
    profileName?: Writable<string>;
  }
>((event, { draftName, profile, profileName }) => {
  const name = (event.name ?? event.detail?.message ?? event.target?.value ??
    draftName?.get() ?? "").trim();
  if (name) {
    (profile.resolveAsCell() as Writable<ProfileHomeOutput>).set(
      ProfileHome.inSpace(name)({
        initialName: name,
      }) as ProfileHomeOutput,
    );
    profileName?.set(name);
  }
});

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

export type ProfileCreateInput = {
  profile: Writable<ProfileHomeOutput>;
  profileName?: Writable<string>;
  inputId?: string;
  buttonId?: string;
};

export type ProfileCreateOutput = {
  [NAME]: string;
  [UI]: VNode;
  createProfile: Stream<CreateProfileEvent>;
};

export default pattern<ProfileCreateInput, ProfileCreateOutput>(
  ({ profile, profileName, inputId, buttonId }) => {
    const draftName = new Writable("").for("draftName");
    const createProfile = submitProfileCreation({
      draftName,
      profile: profile as any,
      profileName: profileName as any,
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
