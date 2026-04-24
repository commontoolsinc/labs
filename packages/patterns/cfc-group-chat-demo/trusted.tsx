import {
  type Cfc,
  computed,
  Default,
  handler,
  NAME,
  pattern,
  Stream,
  UI,
  Writable,
  WriteAuthorizedBy,
} from "commonfabric";
import {
  findParticipantBySlot,
  type ImportedClaimedChatMessage,
  makeParticipantSnapshot,
  metaForSlot,
  type Participant,
  type ParticipantProfile,
  type PlainSentChatMessage,
  prepareSentMessageSnapshot,
  type SentChatMessageOne,
  type SentChatMessageThree,
  type SentChatMessageTwo,
  SLOT_IDS,
  type SlotId,
  sortParticipants,
} from "./logic.ts";

export type TrustedActionWriteWithIntegrity<
  T,
  Binding,
  Action extends string,
  Pattern extends string,
  Integrity extends readonly [string, ...string[]],
> = Cfc<
  WriteAuthorizedBy<T, Binding>,
  {
    uiContract: {
      helper: "UiAction";
      action: Action;
      trustedPattern: Pattern;
      requiredEventIntegrity: Integrity;
    };
  }
>;

export type TrustedActionWrite<
  T,
  Binding,
  Action extends string,
  Pattern extends string,
> = TrustedActionWriteWithIntegrity<
  T,
  Binding,
  Action,
  Pattern,
  [Pattern]
>;

export type TrustedActionUiContract<
  T,
  Action extends string,
  Pattern extends string,
> = Cfc<
  T,
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

export type AuthorshipIntegrity<Author extends string> = {
  readonly kind: "authored-by";
  readonly subject: Author;
};

type TrustedParticipantOne = Cfc<
  ParticipantProfile<"participant-1">,
  { integrity: readonly [AuthorshipIntegrity<"participant-1">] }
>;

type TrustedParticipantTwo = Cfc<
  ParticipantProfile<"participant-2">,
  { integrity: readonly [AuthorshipIntegrity<"participant-2">] }
>;

type TrustedParticipantThree = Cfc<
  ParticipantProfile<"participant-3">,
  { integrity: readonly [AuthorshipIntegrity<"participant-3">] }
>;

export type TrustedParticipant =
  | TrustedParticipantOne
  | TrustedParticipantTwo
  | TrustedParticipantThree;

export type TrustedSentMessageOne = Cfc<
  TrustedActionWriteWithIntegrity<
    SentChatMessageOne,
    typeof commitTrustedMessageSend,
    typeof TRUSTED_GROUP_CHAT_SEND_ACTION,
    typeof TRUSTED_GROUP_CHAT_SEND_SURFACE,
    [typeof TRUSTED_GROUP_CHAT_SEND_SURFACE]
  >,
  { integrity: readonly [AuthorshipIntegrity<"participant-1">] }
>;

export type TrustedSentMessageTwo = Cfc<
  TrustedActionWriteWithIntegrity<
    SentChatMessageTwo,
    typeof commitTrustedMessageSend,
    typeof TRUSTED_GROUP_CHAT_SEND_ACTION,
    typeof TRUSTED_GROUP_CHAT_SEND_SURFACE,
    [typeof TRUSTED_GROUP_CHAT_SEND_SURFACE]
  >,
  { integrity: readonly [AuthorshipIntegrity<"participant-2">] }
>;

export type TrustedSentMessageThree = Cfc<
  TrustedActionWriteWithIntegrity<
    SentChatMessageThree,
    typeof commitTrustedMessageSend,
    typeof TRUSTED_GROUP_CHAT_SEND_ACTION,
    typeof TRUSTED_GROUP_CHAT_SEND_SURFACE,
    [typeof TRUSTED_GROUP_CHAT_SEND_SURFACE]
  >,
  { integrity: readonly [AuthorshipIntegrity<"participant-3">] }
>;

export type TrustedSentChatMessage =
  | TrustedSentMessageOne
  | TrustedSentMessageTwo
  | TrustedSentMessageThree;

export type SharedChatMessage =
  | TrustedSentChatMessage
  | ImportedClaimedChatMessage;

type SharedParticipantsWritable = Writable<
  TrustedParticipant[] | Default<[]>
>;
type SharedMessagesWritable = Writable<SharedChatMessage[] | Default<[]>>;

export const participantsValue = (
  participants: SharedParticipantsWritable,
): TrustedParticipant[] =>
  Array.from((participants.get() as TrustedParticipant[] | undefined) ?? []);

export const messagesValue = (
  messages: SharedMessagesWritable,
): SharedChatMessage[] =>
  Array.from((messages.get() as SharedChatMessage[] | undefined) ?? []);

const makeTrustedParticipant = (
  slotId: SlotId,
  name: string,
): TrustedParticipant => {
  const participant = makeParticipantSnapshot(slotId, name);
  switch (slotId) {
    case "participant-1":
      return participant as TrustedParticipantOne;
    case "participant-2":
      return participant as TrustedParticipantTwo;
    case "participant-3":
      return participant as TrustedParticipantThree;
  }
};

const makeTrustedSentMessage = (
  slotId: SlotId,
  message: PlainSentChatMessage,
): TrustedSentChatMessage => {
  switch (slotId) {
    case "participant-1":
      return message as TrustedSentMessageOne;
    case "participant-2":
      return message as TrustedSentMessageTwo;
    case "participant-3":
      return message as TrustedSentMessageThree;
  }
};

export const applyTrustedProfileSave = (
  participants: readonly TrustedParticipant[],
  slotId: SlotId,
  rawName: string,
): {
  trimmedName: string | null;
  nextParticipants: TrustedParticipant[];
} => {
  const participantList = Array.from(participants);
  const trimmedName = rawName.trim();
  if (!trimmedName) {
    return {
      trimmedName: null,
      nextParticipants: participantList,
    };
  }

  return {
    trimmedName,
    nextParticipants: sortParticipants([
      ...participantList.filter((participant) => participant.id !== slotId),
      makeTrustedParticipant(slotId, trimmedName),
    ]),
  };
};

export const prepareTrustedMessageSend = (
  participants: readonly TrustedParticipant[],
  slotId: SlotId,
  rawBody: string,
): {
  trimmedBody: string | null;
  message: TrustedSentChatMessage | null;
} => {
  const { trimmedBody, message } = prepareSentMessageSnapshot(
    participants as readonly Participant[],
    slotId,
    rawBody,
  );
  if (!trimmedBody || !message) {
    return {
      trimmedBody: null,
      message: null,
    };
  }

  return {
    trimmedBody,
    message: makeTrustedSentMessage(slotId, message),
  };
};

export const applyTrustedMessageSend = (
  messages: readonly SharedChatMessage[],
  participants: readonly TrustedParticipant[],
  slotId: SlotId,
  rawBody: string,
): {
  trimmedBody: string | null;
  nextMessages: SharedChatMessage[];
} => {
  const messageList = Array.from(messages);
  const { trimmedBody, message } = prepareTrustedMessageSend(
    participants,
    slotId,
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
    slotId: SlotId;
    nameDraft: Writable<string>;
    participants: SharedParticipantsWritable;
  }
>((_, { slotId, nameDraft, participants }) => {
  const sharedParticipants = participants
    .resolveAsCell() as SharedParticipantsWritable;
  const { trimmedName, nextParticipants } = applyTrustedProfileSave(
    participantsValue(sharedParticipants),
    slotId,
    nameDraft.get(),
  );
  if (!trimmedName) {
    return;
  }

  sharedParticipants.set(
    nextParticipants as TrustedParticipant[] | Default<[]>,
  );
});

export const commitTrustedMessageSend = handler<
  void,
  {
    slotId: SlotId;
    messageDraft: Writable<string>;
    participants: SharedParticipantsWritable;
    messages: SharedMessagesWritable;
  }
>((_, { slotId, messageDraft, participants, messages }) => {
  const sharedParticipants = participants
    .resolveAsCell() as SharedParticipantsWritable;
  const sharedMessages = messages.resolveAsCell() as SharedMessagesWritable;
  const { trimmedBody, message } = prepareTrustedMessageSend(
    participantsValue(sharedParticipants),
    slotId,
    messageDraft.get(),
  );
  if (!trimmedBody || !message) {
    return;
  }

  sharedMessages.push(message as SharedChatMessage);
  messageDraft.set("");
});

export type SharedParticipantsValue = TrustedParticipant[] | Default<[]>;

export type SharedMessagesValue = SharedChatMessage[] | Default<[]>;

export type SharedParticipantsCell = Writable<SharedParticipantsValue>;
export type SharedMessagesCell = SharedMessagesWritable;

export interface SharedChatStateValue {
  participants: SharedParticipantsValue;
  messages: SharedMessagesValue;
}

export type SharedChatStateCell = Writable<SharedChatStateValue>;

interface TrustedParticipantsPanelInput {
  participants: SharedParticipantsCell;
  viewerSlotId: SlotId;
  id: string;
}

const TrustedParticipantsPanel = pattern<
  TrustedParticipantsPanelInput,
  { [NAME]: string; [UI]: any }
>((
  { participants, viewerSlotId, id }: TrustedParticipantsPanelInput,
): { [NAME]: string; [UI]: any } => ({
  [NAME]: computed(() => `${id} participants panel`),
  [UI]: (
    <cf-hstack id={id} gap="2" wrap>
      {SLOT_IDS.map((slotId) => (
        <div
          id={`${id}-${slotId}-name`}
          data-participant-slot={slotId}
        >
          <cf-chip
            label={computed(() => {
              const saved = findParticipantBySlot(
                participantsValue(participants),
                slotId,
              );
              return saved ? saved.name : metaForSlot(slotId).label;
            })}
            variant={computed(() => {
              const saved = findParticipantBySlot(
                participantsValue(participants),
                slotId,
              );
              if (slotId === viewerSlotId) {
                return "primary";
              }
              return saved ? "accent" : "default";
            })}
          />
        </div>
      ))}
    </cf-hstack>
  ),
}));

export interface TrustedProfileSaveSurfaceInput {
  slotId: SlotId;
  nameDraft: Writable<string>;
  participants: SharedParticipantsCell;
}

export interface TrustedProfileSaveSurfaceOutput {
  [NAME]: string;
  [UI]: any;
  participants: SharedParticipantsCell;
  saveProfile: Stream<void>;
}

export const TrustedProfileSaveSurface = pattern<
  TrustedProfileSaveSurfaceInput,
  TrustedProfileSaveSurfaceOutput
>((
  { slotId, nameDraft, participants }: TrustedProfileSaveSurfaceInput,
): TrustedProfileSaveSurfaceOutput => {
  const meta = metaForSlot(slotId);
  const saveProfile = commitTrustedProfileSave({
    slotId,
    nameDraft,
    participants,
  });
  const currentSavedName = computed(() => {
    const saved = findParticipantBySlot(
      participantsValue(participants),
      slotId,
    );
    return saved ? saved.name : "Name not set";
  });
  const saveDisabled = computed(() => nameDraft.get().trim().length === 0);

  return {
    [NAME]: computed(() => `${meta.label} profile save`),
    [UI]: (
      <cf-card
        id={`trusted-profile-surface-${slotId}`}
        data-ui-pattern={TRUSTED_GROUP_CHAT_PROFILE_SURFACE}
        data-ui-event-integrity={TRUSTED_GROUP_CHAT_PROFILE_SURFACE}
      >
        <cf-hstack slot="content" gap="2" align="center" wrap>
          <cf-chip label={meta.label} variant="primary" />
          <cf-vgroup gap="sm" style={{ minWidth: "12rem", flex: "1 1 12rem" }}>
            <cf-input
              id={`trusted-profile-name-${slotId}`}
              size="sm"
              $value={nameDraft}
              placeholder="Set your name"
            />
          </cf-vgroup>
          <cf-button
            id={`trusted-profile-save-${slotId}`}
            data-ui-action={TRUSTED_GROUP_CHAT_SAVE_PROFILE_ACTION}
            size="sm"
            disabled={saveDisabled}
            onClick={saveProfile}
          >
            Save name
          </cf-button>
          <cf-label id={`trusted-profile-status-${slotId}`}>
            {currentSavedName}
          </cf-label>
        </cf-hstack>
      </cf-card>
    ),
    participants,
    saveProfile,
  };
});

export interface TrustedChatSendSurfaceInput {
  slotId: SlotId;
  messageDraft: Writable<string>;
  participants: SharedParticipantsCell;
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
  { slotId, messageDraft, participants, messages }: TrustedChatSendSurfaceInput,
): TrustedChatSendSurfaceOutput => {
  const sendDisabled = computed(() =>
    findParticipantBySlot(participantsValue(participants), slotId) ===
      undefined ||
    messageDraft.get().trim().length === 0
  );
  const sendMessage = commitTrustedMessageSend({
    slotId,
    messageDraft,
    participants,
    messages,
  });

  return {
    [NAME]: computed(() => `${metaForSlot(slotId).label} send surface`),
    [UI]: (
      <cf-card
        id={`trusted-send-surface-${slotId}`}
        data-ui-pattern={TRUSTED_GROUP_CHAT_SEND_SURFACE}
        data-ui-event-integrity={TRUSTED_GROUP_CHAT_SEND_SURFACE}
      >
        <cf-vstack slot="content" gap="2">
          {TrustedParticipantsPanel({
            participants,
            viewerSlotId: slotId,
            id: `trusted-participants-panel-${slotId}`,
          })}
          <cf-hstack align="center" wrap gap="2">
            <cf-vgroup
              gap="sm"
              style={{ minWidth: "16rem", flex: "1 1 16rem" }}
            >
              <cf-input
                id={`trusted-message-draft-${slotId}`}
                size="sm"
                $value={messageDraft}
                placeholder="Write a message"
              />
            </cf-vgroup>
            <cf-button
              id={`trusted-send-button-${slotId}`}
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

interface VerifiedIndexedChatBubbleInput {
  messages: SharedMessagesCell;
  viewerSlotId: SlotId;
}

export const VerifiedChatBubble = pattern<
  VerifiedIndexedChatBubbleInput,
  { [NAME]: string; [UI]: any }
>((
  { messages, viewerSlotId }: VerifiedIndexedChatBubbleInput,
): { [NAME]: string; [UI]: any } => {
  const message = messages.key(0) as Writable<SharedChatMessage>;
  const authorCell = message.key("author") as Writable<
    SharedChatMessage["author"]
  >;
  const requiredTextIntegrity = computed(() => ({
    kind: "authored-by",
    subject: `${authorCell.key("id").get()}`,
  } satisfies AuthorshipIntegrity<string>));
  const messageRole = computed(() =>
    authorCell.key("id").get() === viewerSlotId ? "user" : "assistant"
  );

  return {
    [NAME]: "verified message bubble 0",
    [UI]: (
      <cf-cfc-authorship
        data-authorship-surface={message.key("id")}
        $value={message}
        $author={authorCell}
        verifyTextIntegrity
        allowLiteralText={false}
        requiredTextIntegrity={requiredTextIntegrity}
      >
        <cf-chat-message
          compact
          role={messageRole}
          name={authorCell.key("name")}
          content={message.key("body")}
        />
      </cf-cfc-authorship>
    ),
  };
});

export const VerifiedChatBubble1 = pattern<
  VerifiedIndexedChatBubbleInput,
  { [NAME]: string; [UI]: any }
>((
  { messages, viewerSlotId }: VerifiedIndexedChatBubbleInput,
): { [NAME]: string; [UI]: any } => {
  const message = messages.key(1) as Writable<SharedChatMessage>;
  const authorCell = message.key("author") as Writable<
    SharedChatMessage["author"]
  >;
  const requiredTextIntegrity = computed(() => ({
    kind: "authored-by",
    subject: `${authorCell.key("id").get()}`,
  } satisfies AuthorshipIntegrity<string>));
  const messageRole = computed(() =>
    authorCell.key("id").get() === viewerSlotId ? "user" : "assistant"
  );

  return {
    [NAME]: "verified message bubble 1",
    [UI]: (
      <cf-cfc-authorship
        data-authorship-surface={message.key("id")}
        $value={message}
        $author={authorCell}
        verifyTextIntegrity
        allowLiteralText={false}
        requiredTextIntegrity={requiredTextIntegrity}
      >
        <cf-chat-message
          compact
          role={messageRole}
          name={authorCell.key("name")}
          content={message.key("body")}
        />
      </cf-cfc-authorship>
    ),
  };
});

export const VerifiedChatBubble2 = pattern<
  VerifiedIndexedChatBubbleInput,
  { [NAME]: string; [UI]: any }
>((
  { messages, viewerSlotId }: VerifiedIndexedChatBubbleInput,
): { [NAME]: string; [UI]: any } => {
  const message = messages.key(2) as Writable<SharedChatMessage>;
  const authorCell = message.key("author") as Writable<
    SharedChatMessage["author"]
  >;
  const requiredTextIntegrity = computed(() => ({
    kind: "authored-by",
    subject: `${authorCell.key("id").get()}`,
  } satisfies AuthorshipIntegrity<string>));
  const messageRole = computed(() =>
    authorCell.key("id").get() === viewerSlotId ? "user" : "assistant"
  );

  return {
    [NAME]: "verified message bubble 2",
    [UI]: (
      <cf-cfc-authorship
        data-authorship-surface={message.key("id")}
        $value={message}
        $author={authorCell}
        verifyTextIntegrity
        allowLiteralText={false}
        requiredTextIntegrity={requiredTextIntegrity}
      >
        <cf-chat-message
          compact
          role={messageRole}
          name={authorCell.key("name")}
          content={message.key("body")}
        />
      </cf-cfc-authorship>
    ),
  };
});

export const VerifiedChatBubble3 = pattern<
  VerifiedIndexedChatBubbleInput,
  { [NAME]: string; [UI]: any }
>((
  { messages, viewerSlotId }: VerifiedIndexedChatBubbleInput,
): { [NAME]: string; [UI]: any } => {
  const message = messages.key(3) as Writable<SharedChatMessage>;
  const authorCell = message.key("author") as Writable<
    SharedChatMessage["author"]
  >;
  const requiredTextIntegrity = computed(() => ({
    kind: "authored-by",
    subject: `${authorCell.key("id").get()}`,
  } satisfies AuthorshipIntegrity<string>));
  const messageRole = computed(() =>
    authorCell.key("id").get() === viewerSlotId ? "user" : "assistant"
  );

  return {
    [NAME]: "verified message bubble 3",
    [UI]: (
      <cf-cfc-authorship
        data-authorship-surface={message.key("id")}
        $value={message}
        $author={authorCell}
        verifyTextIntegrity
        allowLiteralText={false}
        requiredTextIntegrity={requiredTextIntegrity}
      >
        <cf-chat-message
          compact
          role={messageRole}
          name={authorCell.key("name")}
          content={message.key("body")}
        />
      </cf-cfc-authorship>
    ),
  };
});
