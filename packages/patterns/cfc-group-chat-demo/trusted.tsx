import {
  AddIntegrity,
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
export const TRUSTED_GROUP_CHAT_SAVE_PROFILE_ACTION =
  "TrustedGroupChatSaveProfile";
export const TRUSTED_GROUP_CHAT_SEND_ACTION = "TrustedGroupChatSendMessage";
export const TRUSTED_GROUP_CHAT_ADD_ROOM_ACTION = "TrustedGroupChatAddRoom";
export const GROUP_CHAT_ADMIN_INTEGRITY = "group-chat-admin" as const;

export type TrustedProfile = RepresentsCurrentUser<
  TrustedActionWrite<
    ChatProfile,
    typeof commitTrustedProfileSave,
    typeof TRUSTED_GROUP_CHAT_SAVE_PROFILE_ACTION,
    typeof TRUSTED_GROUP_CHAT_PROFILE_SURFACE
  >
>;

export type AdminCredential = AddIntegrity<
  { readonly isAdmin: true },
  readonly [typeof GROUP_CHAT_ADMIN_INTEGRITY]
>;

export type ProfileCell = Writable<ChatProfile | undefined>;
export type TrustedProfileCell = Writable<TrustedProfile>;
export type AdminCredentialCell = Writable<AdminCredential | null>;
export type AdminDraftCell = Writable<boolean | Default<false>>;

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

export type TrustedChatRoom = ChatRoom<SharedChatMessage>;

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

export const currentUserIsAdmin = (
  adminCredential: AdminCredentialCell,
): boolean => adminCredentialValueIsAdmin(adminCredential.get());

const adminCredentialValueIsAdmin = (
  adminCredential: AdminCredential | null | undefined,
): boolean => adminCredential?.isAdmin === true;

export const participantClaimsValue = (
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
  myProfile: MyProfileCell,
  messages: SharedMessagesCell,
): string => {
  const participants = participantClaimsValue(myProfile, messages);
  return participants.length === 0
    ? "No participants yet"
    : participants.map((participant) => participant.name).join(" · ");
};

export const applyTrustedProfileSave = (
  myProfile: MyProfileCell,
  adminCredential: AdminCredentialCell,
  rawName: string,
  wantsAdmin: boolean,
): { trimmedName: string | null; profile?: ProfileCell; isAdmin: boolean } => {
  const trimmedName = rawName.trim();
  if (!trimmedName) {
    return { trimmedName: null, isAdmin: currentUserIsAdmin(adminCredential) };
  }

  const existingProfile = currentProfileSnapshot(myProfile);
  const profile = currentProfileCell(myProfile) ??
    Writable.for<TrustedProfile>("profile");
  profile.set(
    makeProfileSnapshot(trimmedName, existingProfile) as TrustedProfile,
  );
  myProfile.set({ profile });
  if (wantsAdmin) {
    adminCredential.set({ isAdmin: true } as AdminCredential);
    return { trimmedName, profile, isAdmin: true };
  }
  adminCredential.set(null);
  return { trimmedName, profile, isAdmin: false };
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
  adminCredential: AdminCredential | null | undefined,
  rawName: string,
): {
  trimmedName: string | null;
  room: TrustedChatRoom | null;
} => {
  const trimmedName = rawName.trim();
  // This read supplies the admin integrity required by the shared rooms write.
  if (!adminCredentialValueIsAdmin(adminCredential) || !trimmedName) {
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
    adminCredential: AdminCredentialCell;
    nameDraft: Writable<string | Default<"">>;
    adminDraft: AdminDraftCell;
  }
>((_, { myProfile, adminCredential, nameDraft, adminDraft }) => {
  const { trimmedName } = applyTrustedProfileSave(
    myProfile,
    adminCredential,
    draftText(nameDraft),
    adminDraft.get() === true,
  );
  if (trimmedName) {
    nameDraft.set(trimmedName);
  }
});

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

export const commitTrustedRoomAdd = handler<
  void,
  {
    adminCredential: AdminCredential | null;
    roomDraft: RoomDraftCell;
    rooms: SharedRoomsCell;
  }
>((_, { adminCredential, roomDraft, rooms }) => {
  const { trimmedName, room } = prepareTrustedRoomAdd(
    adminCredential,
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
  myProfile: MyProfileCell;
  messages: SharedMessagesCell;
  id: string;
}

const TrustedParticipantsPanel = pattern<
  TrustedParticipantsPanelInput,
  { [NAME]: string; [UI]: any }
>((
  { myProfile, messages, id }: TrustedParticipantsPanelInput,
): { [NAME]: string; [UI]: any } => ({
  [NAME]: computed(() => `${id} participants panel`),
  [UI]: (
    <cf-hstack id={id} gap="2" wrap>
      <cf-chip
        label={computed(() => participantSummary(myProfile, messages))}
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
  adminCredential: AdminCredentialCell;
  nameDraft: Writable<string | Default<"">>;
  adminDraft: AdminDraftCell;
}

export interface TrustedProfileSaveSurfaceOutput {
  [NAME]: string;
  [UI]: any;
  myProfile: MyProfileCell;
  adminCredential: AdminCredentialCell;
  currentProfileName: string;
  currentUserIsAdmin: boolean;
  saveProfile: Stream<void>;
}

export const TrustedProfileSaveSurface = pattern<
  TrustedProfileSaveSurfaceInput,
  TrustedProfileSaveSurfaceOutput
>((
  {
    myProfile,
    adminCredential,
    nameDraft,
    adminDraft,
  }: TrustedProfileSaveSurfaceInput,
): TrustedProfileSaveSurfaceOutput => {
  const saveProfile = commitTrustedProfileSave({
    myProfile,
    adminCredential,
    nameDraft,
    adminDraft,
  });
  const currentSavedName = computed(() =>
    currentProfileSnapshot(myProfile)?.name ?? "Name not set"
  );
  const adminStatus = computed(() =>
    currentUserIsAdmin(adminCredential) ? "Admin" : "Not admin"
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
          <cf-checkbox id="trusted-admin-checkbox" $checked={adminDraft}>
            Trusted admin
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
          <cf-chip id="trusted-admin-status" label={adminStatus} />
        </cf-hstack>
      </cf-card>
    ),
    myProfile,
    adminCredential,
    currentProfileName: currentSavedName,
    currentUserIsAdmin: computed(() => currentUserIsAdmin(adminCredential)),
    saveProfile,
  };
});

export interface TrustedChatSendSurfaceInput {
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
  { myProfile, messageDraft, messages }: TrustedChatSendSurfaceInput,
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
  adminCredential: AdminCredentialCell;
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
    adminCredential,
    roomDraft,
    rooms,
  }: TrustedRoomAddSurfaceInput,
): TrustedRoomAddSurfaceOutput => {
  const addRoom = commitTrustedRoomAdd({
    adminCredential,
    roomDraft,
    rooms,
  } as TrustedRoomAddInput);
  const addDisabled = computed(() =>
    !currentUserIsAdmin(adminCredential) ||
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
              currentUserIsAdmin(adminCredential)
                ? "Admins can add rooms"
                : "Save as trusted admin to add rooms"
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
