import {
  AuthoredByCurrentUser,
  Cfc,
  computed,
  Default,
  handler,
  NAME,
  pattern,
  RepresentsCurrentUser,
  Stream,
  toSchema,
  UI,
  Writable,
  WriteAuthorizedBy,
} from "commonfabric";
import {
  type ChatProfile,
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
export const TRUSTED_GROUP_CHAT_SAVE_PROFILE_ACTION =
  "TrustedGroupChatSaveProfile";
export const TRUSTED_GROUP_CHAT_SEND_ACTION = "TrustedGroupChatSendMessage";

export type TrustedProfile = RepresentsCurrentUser<
  TrustedActionWrite<
    ChatProfile,
    typeof commitTrustedProfileSave,
    typeof TRUSTED_GROUP_CHAT_SAVE_PROFILE_ACTION,
    typeof TRUSTED_GROUP_CHAT_PROFILE_SURFACE
  >
>;

export type ProfileCell = Writable<ChatProfile>;
export type TrustedProfileCell = Writable<TrustedProfile>;

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
const MY_PROFILE_VALUE_SCHEMA = toSchema<MyProfileValue>();
const TRUSTED_PROFILE_SCHEMA = toSchema<TrustedProfile>();

export type TrustedSentChatMessage = AuthoredByCurrentUser<
  TrustedActionWrite<
    SentChatMessage<ProfileCell>,
    typeof commitTrustedMessageSend,
    typeof TRUSTED_GROUP_CHAT_SEND_ACTION,
    typeof TRUSTED_GROUP_CHAT_SEND_SURFACE
  >
>;

export type ImportedClaimedChatMessage = PlainImportedClaimedChatMessage<
  ProfileCell
>;

export type SharedChatMessage =
  | TrustedSentChatMessage
  | ImportedClaimedChatMessage;
export type SharedChatMessageCell =
  & Writable<SharedChatMessage>
  & SharedChatMessage;

export type SharedMessagesValue = SharedChatMessage[] | Default<[]>;
export type SharedMessagesCell = Writable<SharedMessagesValue>;
type SchemaReadableCell<T> = {
  asSchema(schema: unknown): { get(): T | undefined };
};
type TrustedProfileSchemaCell = ProfileCell & {
  asSchema(schema: typeof TRUSTED_PROFILE_SCHEMA): TrustedProfileCell;
};

const draftText = (draft: Writable<string | Default<"">>): string =>
  (draft.get() as string | undefined) ?? "";

export const messagesValue = (
  messages: SharedMessagesCell,
): SharedChatMessage[] =>
  Array.from((messages.get() as SharedChatMessage[] | undefined) ?? []);

export const myProfileValue = (
  myProfile: MyProfileCell,
): MyProfileValue =>
  (myProfile as MyProfileCell & SchemaReadableCell<MyProfileValue>)
    .asSchema(MY_PROFILE_VALUE_SCHEMA)
    .get() ?? {};

export const currentProfileCell = (
  myProfile: MyProfileCell,
): TrustedProfileCell | undefined =>
  myProfileValue(myProfile).profile
    ? (myProfileValue(myProfile).profile as TrustedProfileSchemaCell).asSchema(
      TRUSTED_PROFILE_SCHEMA,
    )
    : undefined;

export const currentProfileSnapshot = (
  myProfile: MyProfileCell,
): TrustedProfile | undefined => currentProfileCell(myProfile)?.get();

export const profileCellKey = (cell: unknown): string | undefined => {
  try {
    const resolved = (cell as { resolveAsCell?: () => unknown })
      ?.resolveAsCell?.() ?? cell;
    const link = (resolved as {
      getAsNormalizedFullLink?: () => { id?: string; scope?: string };
      getAsLink?: () => string;
    }).getAsNormalizedFullLink?.();
    if (link?.id) {
      return `${link.scope ?? "space"}:${link.id}`;
    }
    return (resolved as { getAsLink?: () => string }).getAsLink?.();
  } catch {
    return undefined;
  }
};

export const sameProfileCell = (left: unknown, right: unknown): boolean => {
  const leftKey = profileCellKey(left);
  return leftKey !== undefined && leftKey === profileCellKey(right);
};

export const participantClaimsValue = (
  myProfile: MyProfileCell,
  messages: SharedMessagesCell,
): ParticipantClaim<ProfileCell>[] => {
  const seen = new Set<string>();
  const participants: ParticipantClaim<ProfileCell>[] = [];
  const addParticipant = (
    name: string | undefined,
    accentColor: string | undefined,
    profile: ProfileCell | undefined,
  ) => {
    if (!name) {
      return;
    }
    const profileKey = profileCellKey(profile);
    const key = profileKey === undefined
      ? `unverified:${participants.length}`
      : `profile:${profileKey}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
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
    const profile = message.authorProfile as ProfileCell | undefined;
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
  rawName: string,
): { trimmedName: string | null; profile?: TrustedProfileCell } => {
  const trimmedName = rawName.trim();
  if (!trimmedName) {
    return { trimmedName: null };
  }

  const existingProfile = currentProfileSnapshot(myProfile);
  if (existingProfile) {
    currentProfileCell(myProfile)?.set(
      makeProfileSnapshot(
        trimmedName,
        existingProfile,
      ) as TrustedProfile,
    );
    return { trimmedName, profile: currentProfileCell(myProfile) };
  }

  const profile = Writable.for<TrustedProfile>("profile") as TrustedProfileCell;
  profile.set(makeProfileSnapshot(trimmedName) as TrustedProfile);
  myProfile.set({ profile });
  return { trimmedName, profile };
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

  return {
    trimmedBody,
    message: createSentMessageSnapshot(
      currentProfileCell(myProfile) as TrustedProfileCell,
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

export const commitTrustedProfileSave = handler<
  void,
  {
    myProfile: MyProfileCell;
    nameDraft: Writable<string | Default<"">>;
  }
>((_, { myProfile, nameDraft }) => {
  const { trimmedName } = applyTrustedProfileSave(
    myProfile,
    draftText(nameDraft),
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
  nameDraft: Writable<string | Default<"">>;
}

export interface TrustedProfileSaveSurfaceOutput {
  [NAME]: string;
  [UI]: any;
  myProfile: MyProfileCell;
  currentProfileName: string;
  saveProfile: Stream<void>;
}

export const TrustedProfileSaveSurface = pattern<
  TrustedProfileSaveSurfaceInput,
  TrustedProfileSaveSurfaceOutput
>((
  { myProfile, nameDraft }: TrustedProfileSaveSurfaceInput,
): TrustedProfileSaveSurfaceOutput => {
  const saveProfile = commitTrustedProfileSave({
    myProfile,
    nameDraft,
  });
  const currentSavedName = computed(() =>
    currentProfileSnapshot(myProfile)?.name ?? "Name not set"
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
        </cf-hstack>
      </cf-card>
    ),
    myProfile,
    currentProfileName: currentSavedName,
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

interface VerifiedChatBubbleInput {
  message: SharedChatMessageCell;
  mine?: boolean;
}

export const VerifiedChatBubble = pattern<
  VerifiedChatBubbleInput,
  { [NAME]: string; [UI]: any }
>((
  { message, mine }: VerifiedChatBubbleInput,
): { [NAME]: string; [UI]: any } => ({
  [NAME]: "verified message bubble",
  [UI]: (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: mine ? "flex-end" : "flex-start",
        gap: "4px",
        width: "100%",
      }}
    >
      <span
        style={{
          fontSize: "12px",
          color: "var(--cf-color-text-secondary)",
        }}
      >
        {message.authorName}
      </span>
      <cf-cfc-authorship
        data-authorship-surface={message.id}
        $value={message.body}
        $author={message.authorProfile}
        authorName={message.authorName}
        data-badge-placement={mine ? "end" : "start"}
      >
        <span
          style={{
            display: "inline-block",
            maxWidth: "100%",
            padding: "8px 10px",
            borderRadius: mine ? "14px 14px 4px 14px" : "14px 14px 14px 4px",
            background: mine
              ? "var(--cf-color-primary, #2563eb)"
              : "var(--cf-color-surface-raised, #f3f4f6)",
            color: mine
              ? "var(--cf-color-on-primary, #ffffff)"
              : "var(--cf-color-text, #111827)",
            overflowWrap: "anywhere",
            whiteSpace: "pre-wrap",
          }}
        >
          {message.body}
        </span>
      </cf-cfc-authorship>
    </div>
  ),
}));

export type ParticipantClaimValue = ParticipantClaim<ProfileCell>;
export type AnyPlainChatMessage = PlainChatMessage<ProfileCell>;
