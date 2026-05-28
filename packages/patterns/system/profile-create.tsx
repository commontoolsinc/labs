import { NAME, pattern, Stream, UI, type VNode } from "commonfabric";

export const TRUSTED_PROFILE_CREATE_SURFACE = "ProfileCreateSurface";
export const TRUSTED_PROFILE_CREATE_ACTION = "CreateProfile";

export type CreateProfileEvent = {
  detail?: { message?: string };
  key?: string;
  name?: string;
  target?: { value?: string };
};

export type ProfileCreateInput = {
  createProfile: Stream<CreateProfileEvent>;
  inputId?: string;
  buttonId?: string;
};

export type ProfileCreateOutput = {
  [NAME]: string;
  [UI]: VNode;
};

export default pattern<ProfileCreateInput, ProfileCreateOutput>(
  ({ createProfile, inputId, buttonId }) => {
    return {
      [NAME]: "Create Profile",
      [UI]: (
        <cf-vstack
          id="profile-create-surface"
          data-ui-pattern={TRUSTED_PROFILE_CREATE_SURFACE}
          data-ui-event-integrity={TRUSTED_PROFILE_CREATE_SURFACE}
          gap="1"
        >
          <cf-message-input
            id={inputId ?? "profile-name-input"}
            data-ui-action={TRUSTED_PROFILE_CREATE_ACTION}
            data-profile-create-button={buttonId ?? "profile-create-button"}
            placeholder="Your name..."
            appearance="rounded"
            oncf-send={createProfile}
          />
        </cf-vstack>
      ),
    };
  },
);
