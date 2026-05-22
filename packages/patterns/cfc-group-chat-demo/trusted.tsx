import {
  type AddIntegrity,
  AuthoredByCurrentUser,
  Cfc,
  computed,
  Default,
  equals,
  handler,
  NAME,
  pattern,
  RepresentsCurrentUser,
  RequiresIntegrity,
  Stream,
  UI,
  Writable,
  WriteAuthorizedBy,
} from "commonfabric";
import {
  activeAdminRoleForSubject,
  type AdminManagerCredential,
  adminManagerCredentialIsActive,
  adminRegistryEntries,
  type EmptyAdminRegistryValue,
  subjectHasAdminRole,
} from "../admin.ts";
import {
  type ChatProfile,
  type ChatRoom,
  createRoomSnapshot,
  createSentMessageSnapshot,
  type ImportedClaimedChatMessage as PlainImportedClaimedChatMessage,
  makeProfileSnapshot,
  type ParticipantClaim,
  type PlainChatMessage,
  type SentChatMessage,
} from "./logic.ts";

export type TrustedActionWrite<
  T,
  Binding,
  Action extends string,
  Pattern extends string,
> = Cfc<
  WriteAuthorizedBy<T, Binding>,
  {
    uiContract: {
      helper: "UiAction";
      action: Action;
      trustedPattern: Pattern;
      requiredEventIntegrity: [Pattern];
    };
  }
>;

export const TRUSTED_GROUP_CHAT_PROFILE_SURFACE =
  "TrustedGroupChatProfileSurface";
export const TRUSTED_GROUP_CHAT_SEND_SURFACE = "TrustedGroupChatSendSurface";
export const TRUSTED_GROUP_CHAT_ROOM_SURFACE = "TrustedGroupChatRoomSurface";
export const TRUSTED_GROUP_CHAT_ADMIN_SURFACE = "TrustedGroupChatAdminSurface";
export const TRUSTED_GROUP_CHAT_SAVE_PROFILE_ACTION =
  "TrustedGroupChatSaveProfile";
export const TRUSTED_GROUP_CHAT_SEND_ACTION = "TrustedGroupChatSendMessage";
export const TRUSTED_GROUP_CHAT_ADD_ROOM_ACTION = "TrustedGroupChatAddRoom";
export const TRUSTED_GROUP_CHAT_SET_ADMIN_ACTION = "TrustedGroupChatSetAdmin";
export const GROUP_CHAT_ADMIN_INTEGRITY = "group-chat-admin" as const;
export const GROUP_CHAT_ADMIN_MANAGER_INTEGRITY =
  "group-chat-admin-manager" as const;

export type TrustedProfile = RepresentsCurrentUser<
  TrustedActionWrite<
    ChatProfile,
    typeof commitTrustedProfileSave,
    typeof TRUSTED_GROUP_CHAT_SAVE_PROFILE_ACTION,
    typeof TRUSTED_GROUP_CHAT_PROFILE_SURFACE
  >
>;

export type ProfileCell = Writable<ChatProfile | undefined>;
export type TrustedProfileCell = Writable<TrustedProfile>;
export interface ChatAdminRoleAssignment {
  readonly subject: ProfileCell;
  readonly displayName: string;
}
export type ChatAdminRole = AddIntegrity<
  ChatAdminRoleAssignment,
  readonly [typeof GROUP_CHAT_ADMIN_INTEGRITY]
>;
export type ChatAdminManagerCredential = AdminManagerCredential<
  typeof GROUP_CHAT_ADMIN_MANAGER_INTEGRITY
>;
export type AdminManagerCredentialCell = Writable<
  ChatAdminManagerCredential | null
>;
export type AdminManagerDraftCell = Writable<boolean | Default<true>>;

export interface MyProfileValue {
  readonly profile?: ProfileCell;
}

export interface MyProfileStoredValue {
  readonly profile?: ChatProfile;
}

export type EmptyMyProfileValue = Record<PropertyKey, never>;
export type MyProfileCellValue =
  | MyProfileStoredValue
  | Default<EmptyMyProfileValue>;
export type MyProfileCell = Writable<MyProfileCellValue>;
export type AuthorProfileCell = ProfileCell;

export type TrustedSentChatMessage = AuthoredByCurrentUser<
  TrustedActionWrite<
    SentChatMessage<ProfileCell>,
    typeof commitTrustedMessageSend,
    typeof TRUSTED_GROUP_CHAT_SEND_ACTION,
    typeof TRUSTED_GROUP_CHAT_SEND_SURFACE
  >
>;

export type ImportedClaimedChatMessage = PlainImportedClaimedChatMessage<
  AuthorProfileCell
>;

export type SharedChatMessage =
  | TrustedSentChatMessage
  | ImportedClaimedChatMessage;

export type SharedMessagesValue = SharedChatMessage[] | Default<[]>;
export type SharedMessagesCell = Writable<SharedMessagesValue>;

export interface SharedProfileEntry {
  readonly profile: ProfileCell;
}

export type SharedProfilesValue = SharedProfileEntry[] | Default<[]>;
export type SharedProfilesCell = Writable<SharedProfilesValue>;

export type TrustedChatRoom = ChatRoom<SharedChatMessage>;

export type ChatAdminList = RequiresIntegrity<
  TrustedActionWrite<
    ChatAdminRole[],
    typeof commitTrustedAdminToggle,
    typeof TRUSTED_GROUP_CHAT_SET_ADMIN_ACTION,
    typeof TRUSTED_GROUP_CHAT_ADMIN_SURFACE
  >,
  readonly [typeof GROUP_CHAT_ADMIN_MANAGER_INTEGRITY]
>;

export interface ChatAdminRegistryStoredValue {
  readonly admins?: ChatAdminList;
}

export type ChatAdminRegistryValue =
  | ChatAdminRegistryStoredValue
  | Default<EmptyAdminRegistryValue>;
export type ChatAdminRegistryCell = Writable<ChatAdminRegistryValue>;

export type SharedRoomList = RequiresIntegrity<
  TrustedActionWrite<
    TrustedChatRoom[],
    typeof commitTrustedRoomAdd,
    typeof TRUSTED_GROUP_CHAT_ADD_ROOM_ACTION,
    typeof TRUSTED_GROUP_CHAT_ROOM_SURFACE
  >,
  readonly [typeof GROUP_CHAT_ADMIN_INTEGRITY]
>;

export interface SharedRoomsStoredValue {
  readonly list?: SharedRoomList;
}

export type EmptySharedRoomsValue = Record<PropertyKey, never>;
export type SharedRoomsValue =
  | SharedRoomsStoredValue
  | Default<EmptySharedRoomsValue>;
export type SharedRoomsCell = Writable<SharedRoomsValue>;
export type RoomDraftCell = Writable<string | Default<"">>;

const draftText = (draft: Writable<string | Default<"">>): string =>
  (draft.get() as string | undefined) ?? "";

export const messagesValue = (
  messages: SharedMessagesCell,
): SharedChatMessage[] =>
  Array.from((messages.get() as SharedChatMessage[] | undefined) ?? []);

export const profilesValue = (
  profiles: SharedProfilesCell,
): ProfileCell[] =>
  Array.from((profiles.get() as SharedProfileEntry[] | undefined) ?? [])
    .map((entry) => entry.profile)
    .reduce<ProfileCell[]>(
      (uniqueProfiles, profile) =>
        uniqueProfiles.some((knownProfile) => equals(knownProfile, profile))
          ? uniqueProfiles
          : [...uniqueProfiles, profile],
      [],
    );

export const roomsValue = (
  rooms: SharedRoomsCell,
): TrustedChatRoom[] =>
  Array.from((rooms.get() as SharedRoomsStoredValue | undefined)?.list ?? []);

export const myProfileValue = (
  myProfile: MyProfileCell,
): MyProfileStoredValue => myProfile.get() ?? {};

export const currentProfileCell = (
  myProfile: MyProfileCell,
): ProfileCell | undefined =>
  myProfileValue(myProfile).profile === undefined
    ? undefined
    : myProfile.key("profile").resolveAsCell();

export const currentProfileSnapshot = (
  myProfile: MyProfileCell,
): ChatProfile | undefined => currentProfileCell(myProfile)?.get();

export const chatAdminRolesValue = (
  adminRegistry: ChatAdminRegistryCell,
): ChatAdminRole[] => adminRegistryEntries<ChatAdminRole>(adminRegistry);

export const currentUserAdminRole = (
  myProfile: MyProfileCell,
  adminRegistry: ChatAdminRegistryCell,
): ChatAdminRole | undefined =>
  activeAdminRoleForSubject(
    chatAdminRolesValue(adminRegistry),
    currentProfileCell(myProfile),
  );

export const currentUserIsAdmin = (
  myProfile: MyProfileCell,
  adminRegistry: ChatAdminRegistryCell,
): boolean => currentUserAdminRole(myProfile, adminRegistry) !== undefined;

export const currentUserCanManageAdmins = (
  adminManagerCredential: AdminManagerCredentialCell,
): boolean => adminManagerCredentialIsActive(adminManagerCredential.get());

export const participantClaimsValue = (
  profiles: SharedProfilesCell,
  myProfile: MyProfileCell,
  messages: SharedMessagesCell,
): ParticipantClaim<AuthorProfileCell>[] => {
  const participants: ParticipantClaim<AuthorProfileCell>[] = [];
  const addParticipant = (
    name: string | undefined,
    accentColor: string | undefined,
    profile: AuthorProfileCell | undefined,
  ) => {
    if (!name) {
      return;
    }
    if (
      profile !== undefined &&
      participants.some((participant) => equals(profile, participant.profile))
    ) {
      return;
    }
    participants.push({
      name,
      accentColor: accentColor ?? "#64748b",
      ...(profile !== undefined ? { profile } : {}),
    });
  };

  profilesValue(profiles).forEach((profile) => {
    const profileValue = profile.get();
    addParticipant(profileValue?.name, profileValue?.accentColor, profile);
  });

  const mineValue = currentProfileSnapshot(myProfile);
  addParticipant(
    mineValue?.name,
    mineValue?.accentColor,
    currentProfileCell(myProfile),
  );

  messagesValue(messages).forEach((message) => {
    const profile = message.authorProfile;
    const profileValue = profile?.get();
    addParticipant(
      profileValue?.name ?? message.authorName,
      profileValue?.accentColor,
      profile,
    );
  });

  return participants;
};

export const participantSummary = (
  profiles: SharedProfilesCell,
  myProfile: MyProfileCell,
  messages: SharedMessagesCell,
): string => {
  const participants = participantClaimsValue(profiles, myProfile, messages);
  return participants.length === 0
    ? "No participants yet"
    : participants.map((participant) => participant.name).join(" · ");
};

export interface AdminParticipantRow {
  readonly name: string;
  readonly accentColor: string;
  readonly profile?: AuthorProfileCell;
  readonly isAdmin: boolean;
  readonly canManageAdmins: boolean;
}

export const adminParticipantRowsValue = (
  profiles: SharedProfilesCell,
  myProfile: MyProfileCell,
  messages: SharedMessagesCell,
  adminRegistry: ChatAdminRegistryCell,
  adminManagerCredential: AdminManagerCredentialCell,
): AdminParticipantRow[] => {
  const adminRoles = chatAdminRolesValue(adminRegistry);
  const canManageAdmins = currentUserCanManageAdmins(adminManagerCredential);
  return participantClaimsValue(profiles, myProfile, messages)
    .filter((participant) => participant.profile !== undefined)
    .map((participant) => ({
      name: participant.name,
      accentColor: participant.accentColor,
      profile: participant.profile,
      isAdmin: subjectHasAdminRole(adminRoles, participant.profile),
      canManageAdmins,
    }));
};

export const registerProfile = (
  profiles: SharedProfilesCell,
  profile: ProfileCell,
): void => {
  const currentProfiles = profilesValue(profiles);
  const nextProfiles =
    currentProfiles.some((knownProfile) => equals(knownProfile, profile))
      ? currentProfiles
      : [...currentProfiles, profile];
  profiles.set(
    nextProfiles.map((profile) => ({ profile })) as SharedProfilesValue,
  );
};

export const applyTrustedProfileSave = (
  myProfile: MyProfileCell,
  profiles: SharedProfilesCell,
  adminManagerCredential: AdminManagerCredentialCell,
  rawName: string,
  canManageAdmins: boolean,
): {
  trimmedName: string | null;
  profile?: ProfileCell;
  canManageAdmins: boolean;
} => {
  const trimmedName = rawName.trim();
  if (!trimmedName) {
    return {
      trimmedName: null,
      canManageAdmins: currentUserCanManageAdmins(adminManagerCredential),
    };
  }

  const existingProfile = currentProfileSnapshot(myProfile);
  const profile = currentProfileCell(myProfile) ??
    Writable.for<TrustedProfile>("profile");
  profile.set(
    makeProfileSnapshot(trimmedName, existingProfile) as TrustedProfile,
  );
  myProfile.set({ profile });
  registerProfile(profiles, profile);
  if (canManageAdmins) {
    adminManagerCredential.set({
      canManageAdmins: true,
    } as ChatAdminManagerCredential);
    return { trimmedName, profile, canManageAdmins: true };
  }
  adminManagerCredential.set(null);
  return { trimmedName, profile, canManageAdmins: false };
};

export const prepareTrustedMessageSend = (
  myProfile: MyProfileCell,
  rawBody: string,
): {
  trimmedBody: string | null;
  message: TrustedSentChatMessage | null;
} => {
  const profileValue = currentProfileSnapshot(myProfile);
  const trimmedBody = rawBody.trim();
  if (!profileValue || !trimmedBody) {
    return {
      trimmedBody: null,
      message: null,
    };
  }
  const profileCell = currentProfileCell(myProfile);
  if (!profileCell) {
    return {
      trimmedBody: null,
      message: null,
    };
  }

  return {
    trimmedBody,
    message: createSentMessageSnapshot(
      profileCell,
      profileValue,
      trimmedBody,
    ) as TrustedSentChatMessage,
  };
};

export const applyTrustedMessageSend = (
  messages: readonly SharedChatMessage[],
  myProfile: MyProfileCell,
  rawBody: string,
): {
  trimmedBody: string | null;
  nextMessages: SharedChatMessage[];
} => {
  const messageList = Array.from(messages);
  const { trimmedBody, message } = prepareTrustedMessageSend(
    myProfile,
    rawBody,
  );
  if (!trimmedBody || !message) {
    return {
      trimmedBody: null,
      nextMessages: messageList,
    };
  }

  return {
    trimmedBody,
    nextMessages: [
      ...messageList,
      message,
    ],
  };
};

export const prepareTrustedRoomAdd = (
  currentAdminRole: ChatAdminRole | undefined,
  rawName: string,
): {
  trimmedName: string | null;
  room: TrustedChatRoom | null;
} => {
  const trimmedName = rawName.trim();
  // This read supplies the admin integrity required by the shared rooms write.
  if (currentAdminRole === undefined || !trimmedName) {
    return {
      trimmedName: null,
      room: null,
    };
  }

  return {
    trimmedName,
    room: createRoomSnapshot<SharedChatMessage>(
      trimmedName,
    ) as TrustedChatRoom,
  };
};

export const commitTrustedProfileSave = handler<
  void,
  {
    myProfile: MyProfileCell;
    profiles: SharedProfilesCell;
    adminManagerCredential: AdminManagerCredentialCell;
    nameDraft: Writable<string | Default<"">>;
    adminManagerDraft: AdminManagerDraftCell;
  }
>((
  _,
  { myProfile, profiles, adminManagerCredential, nameDraft, adminManagerDraft },
) => {
  const { trimmedName } = applyTrustedProfileSave(
    myProfile,
    profiles,
    adminManagerCredential,
    draftText(nameDraft),
    adminManagerDraft.get() !== false,
  );
  if (trimmedName) {
    nameDraft.set(trimmedName);
  }
});
type TrustedProfileSaveInput = Parameters<typeof commitTrustedProfileSave>[0];

export const commitTrustedMessageSend = handler<
  void,
  {
    myProfile: MyProfileCell;
    messageDraft: Writable<string | Default<"">>;
    messages: SharedMessagesCell;
  }
>((_, { myProfile, messageDraft, messages }) => {
  const { trimmedBody, message } = prepareTrustedMessageSend(
    myProfile,
    draftText(messageDraft),
  );
  if (!trimmedBody || !message) {
    return;
  }

  messages.push(message);
  messageDraft.set("");
});
type TrustedMessageSendInput = Parameters<typeof commitTrustedMessageSend>[0];

export const prepareTrustedAdminToggle = (
  adminManagerCredential: ChatAdminManagerCredential | null | undefined,
  adminRegistry: ChatAdminRegistryCell,
  participant: AdminParticipantRow | undefined,
  myProfile?: MyProfileCell,
): ChatAdminRole[] | null => {
  const targetProfile = participant?.profile ?? (
    myProfile === undefined ? undefined : currentProfileCell(myProfile)
  );
  const targetName = participant?.name ??
    (myProfile === undefined ? undefined : currentProfileSnapshot(myProfile)
      ?.name);
  if (
    !adminManagerCredentialIsActive(adminManagerCredential) ||
    targetProfile === undefined ||
    !targetName
  ) {
    return null;
  }

  const adminRoles = chatAdminRolesValue(adminRegistry);
  const withoutParticipant = adminRoles.filter((role) =>
    !equals(role.subject, targetProfile)
  );
  if (withoutParticipant.length !== adminRoles.length) {
    return withoutParticipant;
  }

  return [
    ...withoutParticipant,
    {
      subject: targetProfile,
      displayName: targetName,
    } as ChatAdminRole,
  ];
};

export const commitTrustedAdminToggle = handler<
  void,
  {
    adminManagerCredential: AdminManagerCredentialCell;
    adminRegistry: ChatAdminRegistryCell;
    participant: AdminParticipantRow | undefined;
    myProfile?: MyProfileCell;
  }
>((_, { adminManagerCredential, adminRegistry, participant, myProfile }) => {
  const nextAdmins = prepareTrustedAdminToggle(
    adminManagerCredential.get(),
    adminRegistry,
    participant,
    myProfile,
  );
  if (nextAdmins === null) {
    return;
  }

  adminRegistry.set({ admins: nextAdmins as ChatAdminList });
});
type TrustedAdminToggleInput = Parameters<typeof commitTrustedAdminToggle>[0];

export const commitTrustedRoomAdd = handler<
  void,
  {
    myProfile: MyProfileCell;
    adminRegistry: ChatAdminRegistryCell;
    roomDraft: RoomDraftCell;
    rooms: SharedRoomsCell;
  }
>((_, { myProfile, adminRegistry, roomDraft, rooms }) => {
  const { trimmedName, room } = prepareTrustedRoomAdd(
    currentUserAdminRole(myProfile, adminRegistry),
    draftText(roomDraft),
  );
  if (!trimmedName || !room) {
    return;
  }

  const nextRooms = [...roomsValue(rooms), room];
  rooms.set({ list: nextRooms as SharedRoomList });
  roomDraft.set("");
});
type TrustedRoomAddInput = Parameters<typeof commitTrustedRoomAdd>[0];

interface TrustedParticipantsPanelInput {
  profiles: SharedProfilesCell;
  myProfile: MyProfileCell;
  messages: SharedMessagesCell;
  id: string;
}

const TrustedParticipantsPanel = pattern<
  TrustedParticipantsPanelInput,
  { [NAME]: string; [UI]: any }
>((
  { profiles, myProfile, messages, id }: TrustedParticipantsPanelInput,
): { [NAME]: string; [UI]: any } => ({
  [NAME]: computed(() => `${id} participants panel`),
  [UI]: (
    <cf-hstack id={id} gap="2" wrap>
      <cf-chip
        label={computed(() =>
          participantSummary(profiles, myProfile, messages)
        )}
        variant="accent"
      />
    </cf-hstack>
  ),
}));
type TrustedParticipantsPanelInputArg = Parameters<
  typeof TrustedParticipantsPanel
>[0];

export interface TrustedProfileSaveSurfaceInput {
  myProfile: MyProfileCell;
  profiles: SharedProfilesCell;
  adminManagerCredential: AdminManagerCredentialCell;
  nameDraft: Writable<string | Default<"">>;
  adminManagerDraft: AdminManagerDraftCell;
}

export interface TrustedProfileSaveSurfaceOutput {
  [NAME]: string;
  [UI]: any;
  myProfile: MyProfileCell;
  adminManagerCredential: AdminManagerCredentialCell;
  currentProfileName: string;
  currentUserCanManageAdmins: boolean;
  saveProfile: Stream<void>;
}

export const TrustedProfileSaveSurface = pattern<
  TrustedProfileSaveSurfaceInput,
  TrustedProfileSaveSurfaceOutput
>((
  {
    myProfile,
    profiles,
    adminManagerCredential,
    nameDraft,
    adminManagerDraft,
  }: TrustedProfileSaveSurfaceInput,
): TrustedProfileSaveSurfaceOutput => {
  const saveProfile = commitTrustedProfileSave({
    myProfile,
    profiles,
    adminManagerCredential,
    nameDraft,
    adminManagerDraft,
  } as TrustedProfileSaveInput);
  const currentSavedName = computed(() =>
    currentProfileSnapshot(myProfile)?.name ?? "Name not set"
  );
  const managerStatus = computed(() =>
    currentUserCanManageAdmins(adminManagerCredential)
      ? "Can manage admins"
      : "Cannot manage admins"
  );
  const saveDisabled = computed(() => draftText(nameDraft).trim().length === 0);

  return {
    [NAME]: "profile save",
    [UI]: (
      <cf-card
        id="trusted-profile-surface"
        data-ui-pattern={TRUSTED_GROUP_CHAT_PROFILE_SURFACE}
        data-ui-event-integrity={TRUSTED_GROUP_CHAT_PROFILE_SURFACE}
      >
        <cf-hstack slot="content" gap="2" align="center" wrap>
          <cf-vgroup gap="sm" style={{ minWidth: "12rem", flex: "1 1 12rem" }}>
            <cf-input
              id="trusted-profile-name"
              size="sm"
              $value={nameDraft}
              placeholder="Set your name"
            />
          </cf-vgroup>
          <cf-checkbox
            id="trusted-admin-manager-checkbox"
            $checked={adminManagerDraft}
          >
            Can manage admins (demo)
          </cf-checkbox>
          <cf-button
            id="trusted-profile-save"
            data-ui-action={TRUSTED_GROUP_CHAT_SAVE_PROFILE_ACTION}
            size="sm"
            disabled={saveDisabled}
            onClick={saveProfile}
          >
            Save name
          </cf-button>
          <cf-label id="trusted-profile-status">
            {currentSavedName}
          </cf-label>
          <cf-chip id="trusted-admin-manager-status" label={managerStatus} />
        </cf-hstack>
      </cf-card>
    ),
    myProfile,
    adminManagerCredential,
    currentProfileName: currentSavedName,
    currentUserCanManageAdmins: computed(() =>
      currentUserCanManageAdmins(adminManagerCredential)
    ),
    saveProfile,
  };
});

export interface TrustedAdminPanelInput {
  profiles: SharedProfilesCell;
  myProfile: MyProfileCell;
  messages: SharedMessagesCell;
  adminRegistry: ChatAdminRegistryCell;
  adminManagerCredential: AdminManagerCredentialCell;
}

export interface TrustedAdminPanelOutput {
  [NAME]: string;
  [UI]: any;
  adminRegistry: ChatAdminRegistryCell;
  toggleCurrentUserAdmin: Stream<void>;
}

export const TrustedAdminPanel = pattern<
  TrustedAdminPanelInput,
  TrustedAdminPanelOutput
>((
  {
    profiles,
    myProfile,
    messages,
    adminRegistry,
    adminManagerCredential,
  }: TrustedAdminPanelInput,
): TrustedAdminPanelOutput => {
  const adminRows = computed(() =>
    adminParticipantRowsValue(
      profiles,
      myProfile,
      messages,
      adminRegistry,
      adminManagerCredential,
    )
  );
  const toggleCurrentUserAdmin = commitTrustedAdminToggle({
    adminManagerCredential,
    adminRegistry,
    participant: undefined,
    myProfile,
  } as TrustedAdminToggleInput);
  const managerStatus = computed(() =>
    currentUserCanManageAdmins(adminManagerCredential)
      ? "Admin registry editing enabled"
      : "Save profile with admin-manager enabled to edit"
  );

  return {
    [NAME]: "admin registry",
    [UI]: (
      <cf-card
        id="trusted-admin-panel"
        data-ui-pattern={TRUSTED_GROUP_CHAT_ADMIN_SURFACE}
        data-ui-event-integrity={TRUSTED_GROUP_CHAT_ADMIN_SURFACE}
      >
        <cf-vstack slot="content" gap="3">
          <cf-hstack justify="between" align="center" wrap gap="2">
            <cf-vstack gap="1">
              <cf-heading level={3}>Users</cf-heading>
              <cf-label>
                Admin registry. Managers can change who may add rooms.
              </cf-label>
            </cf-vstack>
            <cf-chip
              id="trusted-admin-manager-panel-status"
              label={managerStatus}
            />
          </cf-hstack>

          <cf-vstack id="trusted-admin-user-list" gap="2">
            {adminRows.map((participant) => {
              const toggleAdmin = commitTrustedAdminToggle({
                adminManagerCredential,
                adminRegistry,
                participant,
              } as TrustedAdminToggleInput);
              return (
                <cf-hstack
                  align="center"
                  justify="between"
                  gap="2"
                  wrap
                  style={{
                    padding: "0.5rem 0.75rem",
                    border: "1px solid var(--cf-color-border, #e5e7eb)",
                    borderRadius: "0.75rem",
                  }}
                >
                  <cf-hstack align="center" gap="2">
                    <span
                      style={{
                        width: "0.75rem",
                        height: "0.75rem",
                        borderRadius: "9999px",
                        background: participant.accentColor,
                      }}
                    />
                    <cf-label>{participant.name}</cf-label>
                    <cf-chip
                      label={participant.isAdmin ? "Admin" : "Member"}
                      variant={participant.isAdmin ? "accent" : "default"}
                    />
                  </cf-hstack>
                  <cf-button
                    data-ui-action={TRUSTED_GROUP_CHAT_SET_ADMIN_ACTION}
                    size="sm"
                    disabled={!participant.canManageAdmins}
                    onClick={toggleAdmin}
                  >
                    {participant.isAdmin ? "Remove admin" : "Make admin"}
                  </cf-button>
                </cf-hstack>
              );
            })}
          </cf-vstack>
        </cf-vstack>
      </cf-card>
    ),
    adminRegistry,
    toggleCurrentUserAdmin,
  };
});

export interface TrustedChatSendSurfaceInput {
  profiles: SharedProfilesCell;
  myProfile: MyProfileCell;
  messageDraft: Writable<string | Default<"">>;
  messages: SharedMessagesCell;
}

export interface TrustedChatSendSurfaceOutput {
  [NAME]: string;
  [UI]: any;
  messages: SharedMessagesCell;
  sendMessage: Stream<void>;
}

export const TrustedChatSendSurface = pattern<
  TrustedChatSendSurfaceInput,
  TrustedChatSendSurfaceOutput
>((
  { profiles, myProfile, messageDraft, messages }: TrustedChatSendSurfaceInput,
): TrustedChatSendSurfaceOutput => {
  const sendDisabled = computed(() =>
    currentProfileSnapshot(myProfile) === undefined ||
    draftText(messageDraft).trim().length === 0
  );
  const sendMessage = commitTrustedMessageSend({
    myProfile,
    messageDraft,
    messages,
  } as TrustedMessageSendInput);

  return {
    [NAME]: "send surface",
    [UI]: (
      <cf-card
        id="trusted-send-surface"
        data-ui-pattern={TRUSTED_GROUP_CHAT_SEND_SURFACE}
        data-ui-event-integrity={TRUSTED_GROUP_CHAT_SEND_SURFACE}
      >
        <cf-vstack slot="content" gap="2">
          {TrustedParticipantsPanel({
            profiles,
            myProfile,
            messages,
            id: "trusted-participants-panel",
          } as TrustedParticipantsPanelInputArg)}
          <cf-hstack align="center" wrap gap="2">
            <cf-vgroup
              gap="sm"
              style={{ minWidth: "16rem", flex: "1 1 16rem" }}
            >
              <cf-input
                id="trusted-message-draft"
                size="sm"
                $value={messageDraft}
                placeholder="Write a message"
              />
            </cf-vgroup>
            <cf-button
              id="trusted-send-button"
              data-ui-action={TRUSTED_GROUP_CHAT_SEND_ACTION}
              size="sm"
              disabled={sendDisabled}
              onClick={sendMessage}
            >
              Send
            </cf-button>
          </cf-hstack>
        </cf-vstack>
      </cf-card>
    ),
    messages,
    sendMessage,
  };
});

export interface TrustedRoomAddSurfaceInput {
  myProfile: MyProfileCell;
  adminRegistry: ChatAdminRegistryCell;
  roomDraft: RoomDraftCell;
  rooms: SharedRoomsCell;
}

export interface TrustedRoomAddSurfaceOutput {
  [NAME]: string;
  [UI]: any;
  rooms: SharedRoomsCell;
  addRoom: Stream<void>;
}

export const TrustedRoomAddSurface = pattern<
  TrustedRoomAddSurfaceInput,
  TrustedRoomAddSurfaceOutput
>((
  {
    myProfile,
    adminRegistry,
    roomDraft,
    rooms,
  }: TrustedRoomAddSurfaceInput,
): TrustedRoomAddSurfaceOutput => {
  const addRoom = commitTrustedRoomAdd({
    myProfile,
    adminRegistry,
    roomDraft,
    rooms,
  } as TrustedRoomAddInput);
  const addDisabled = computed(() =>
    !currentUserIsAdmin(myProfile, adminRegistry) ||
    draftText(roomDraft).trim().length === 0
  );

  return {
    [NAME]: "room add surface",
    [UI]: (
      <cf-card
        id="trusted-room-surface"
        data-ui-pattern={TRUSTED_GROUP_CHAT_ROOM_SURFACE}
        data-ui-event-integrity={TRUSTED_GROUP_CHAT_ROOM_SURFACE}
      >
        <cf-hstack slot="content" gap="2" align="center" wrap>
          <cf-vgroup gap="sm" style={{ minWidth: "12rem", flex: "1 1 12rem" }}>
            <cf-input
              id="trusted-room-name"
              size="sm"
              $value={roomDraft}
              placeholder="Add a room"
            />
          </cf-vgroup>
          <cf-button
            id="trusted-room-add-button"
            data-ui-action={TRUSTED_GROUP_CHAT_ADD_ROOM_ACTION}
            size="sm"
            disabled={addDisabled}
            onClick={addRoom}
          >
            Add room
          </cf-button>
          <cf-label id="trusted-room-admin-hint">
            {computed(() =>
              currentUserIsAdmin(myProfile, adminRegistry)
                ? "Admins can add rooms"
                : "Ask an admin manager to make you an admin"
            )}
          </cf-label>
        </cf-hstack>
      </cf-card>
    ),
    rooms,
    addRoom,
  };
});

export type ParticipantClaimValue = ParticipantClaim<AuthorProfileCell>;
export type AnyPlainChatMessage = PlainChatMessage<AuthorProfileCell>;
