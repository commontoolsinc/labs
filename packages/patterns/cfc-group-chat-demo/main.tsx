import {
  action,
  type Cfc,
  computed,
  Default,
  handler,
  NAME,
  navigateTo,
  pattern,
  SELF,
  Stream,
  UI,
  type VNode,
  Writable,
  WriteAuthorizedBy,
} from "commonfabric";
import {
  applyTrustedProfileSave,
  type AuthorshipIntegrity,
  createRandomInvalidClaimedMessages,
  type DisplayChatMessage,
  findParticipantBySlot,
  type InvalidClaimedChatMessage,
  metaForSlot,
  prepareTrustedMessageSend,
  SLOT_IDS,
  type SlotId,
  sortDisplayMessages,
  type TrustedChatMessage,
  type TrustedParticipant,
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

export const TRUSTED_GROUP_CHAT_PROFILE_SURFACE =
  "TrustedGroupChatProfileSurface";
export const TRUSTED_GROUP_CHAT_SEND_SURFACE = "TrustedGroupChatSendSurface";
export const TRUSTED_GROUP_CHAT_SAVE_PROFILE_ACTION =
  "TrustedGroupChatSaveProfile";
export const TRUSTED_GROUP_CHAT_SEND_ACTION = "TrustedGroupChatSendMessage";

type SharedParticipantsWritable = Writable<
  TrustedParticipant[] | Default<[]>
>;
type TrustedMessageEntry = {
  kind: "trusted";
  piece: TrustedChatMessage;
};
type InvalidMessageEntry = {
  kind: "invalid";
  piece: InvalidClaimedChatMessage;
};
type TranscriptMessageEntry = TrustedMessageEntry | InvalidMessageEntry;

type SharedMessagesWritable = Writable<TrustedMessageEntry[] | Default<[]>>;
type InvalidMessagesWritable = Writable<InvalidMessageEntry[] | Default<[]>>;

type LobbyPiece = Writable<{ [NAME]?: string }>;

const participantsValue = (
  participants: SharedParticipantsWritable,
): TrustedParticipant[] => participants.get() as TrustedParticipant[];

const messageEntriesValue = (
  messages: SharedMessagesWritable,
): TrustedMessageEntry[] =>
  Array.from((messages.get() as TrustedMessageEntry[] | undefined) ?? []);

const invalidMessageEntriesValue = (
  invalidMessages: InvalidMessagesWritable,
): InvalidMessageEntry[] =>
  Array.from(
    (invalidMessages.get() as InvalidMessageEntry[] | undefined) ?? [],
  );

const writeDraftText = handler<string, { value: Writable<string> }>(
  (nextValue, { value }) => {
    value.set(nextValue);
  },
);

export const commitTrustedProfileSave = handler<
  void,
  {
    slotId: SlotId;
    nameDraft: Writable<string>;
    participants: SharedParticipantsWritable;
  }
>((_, { slotId, nameDraft, participants }) => {
  const { trimmedName, nextParticipants } = applyTrustedProfileSave(
    participantsValue(participants),
    slotId,
    nameDraft.get(),
  );
  if (!trimmedName) {
    return;
  }

  participants.set(
    nextParticipants as TrustedParticipant[] | Default<[]>,
  );
  nameDraft.set(trimmedName);
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
  const { trimmedBody, message } = prepareTrustedMessageSend(
    participantsValue(participants),
    slotId,
    messageDraft.get(),
  );
  if (!trimmedBody || !message) {
    return;
  }

  messages.push({
    kind: "trusted",
    piece: message,
  });
  messageDraft.set("");
});

export type TrustedParticipantsCollection = TrustedActionWrite<
  TrustedParticipant[],
  typeof commitTrustedProfileSave,
  typeof TRUSTED_GROUP_CHAT_SAVE_PROFILE_ACTION,
  typeof TRUSTED_GROUP_CHAT_PROFILE_SURFACE
>;

export type TrustedMessagesCollection = TrustedActionWrite<
  TrustedMessageEntry[],
  typeof commitTrustedMessageSend,
  typeof TRUSTED_GROUP_CHAT_SEND_ACTION,
  typeof TRUSTED_GROUP_CHAT_SEND_SURFACE
>;

export type SharedParticipantsValue = Default<
  TrustedParticipantsCollection,
  []
>;

export type SharedMessagesValue = Default<TrustedMessagesCollection, []>;
export type InvalidMessagesValue = InvalidMessageEntry[] | Default<[]>;

export type SharedParticipantsCell = Writable<SharedParticipantsValue>;

export type SharedMessagesCell = Writable<SharedMessagesValue>;
export type InvalidMessagesCell = Writable<InvalidMessagesValue>;

const enterGroupChatRoom = handler<
  void,
  {
    slotId: SlotId;
    roomRef: Writable<ParticipantRoomOutput | null>;
    participants: SharedParticipantsCell;
    messages: SharedMessagesCell;
    invalidMessages: InvalidMessagesCell;
    lobbyPiece: LobbyPiece;
  }
>((
  _,
  { slotId, roomRef, participants, messages, invalidMessages, lobbyPiece },
) => {
  const existingRoom = roomRef.get();
  if (existingRoom) {
    return navigateTo(existingRoom);
  }

  const createdRoom = ParticipantRoom({
    slotId,
    participants,
    messages,
    invalidMessages,
    lobbyPiece,
  });
  roomRef.set(createdRoom);
  return navigateTo(createdRoom);
});

interface ParticipantStatusChipInput {
  participants: SharedParticipantsCell;
  slotId: SlotId;
}

const ParticipantStatusChip = pattern<
  ParticipantStatusChipInput,
  { [NAME]: string; [UI]: VNode }
>(({ participants, slotId }) => {
  const statusLabel = computed(() => {
    const saved = findParticipantBySlot(
      participantsValue(participants),
      slotId,
    );
    return saved ? saved.name : "Profile pending";
  });

  return {
    [NAME]: computed(() => `${slotId} status chip`),
    [UI]: <cf-chip label={statusLabel} />,
  };
});

interface TrustedParticipantsPanelInput {
  participants: SharedParticipantsCell;
  viewerSlotId: SlotId;
  id: string;
}

const TrustedParticipantsPanel = pattern<
  TrustedParticipantsPanelInput,
  { [NAME]: string; [UI]: VNode }
>(({ participants, viewerSlotId, id }) => ({
  [NAME]: computed(() => `${id} trusted participants panel`),
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

interface SharedTranscriptInput {
  messages: SharedMessagesCell;
  invalidMessages: InvalidMessagesCell;
  viewerSlotId: SlotId;
  id: string;
}

interface SharedTranscriptMessageRowInput {
  messageEntry: Writable<TranscriptMessageEntry>;
  viewerSlotId: SlotId;
}

const SharedTranscriptMessageRow = pattern<
  SharedTranscriptMessageRowInput,
  VNode
>(({ messageEntry, viewerSlotId }) => {
  const messagePiece = messageEntry.key("piece") as Writable<
    TranscriptMessageEntry["piece"]
  >;
  const authorCell = messagePiece.key("author") as Writable<
    DisplayChatMessage["author"]
  >;
  const requiredTextIntegrity = computed(() => ({
    kind: "authored-by",
    subject: `${authorCell.key("id").get()}`,
  } satisfies AuthorshipIntegrity<string>));
  const messageRole = computed(() =>
    authorCell.key("id").get() === viewerSlotId ? "user" : "assistant"
  );
  const invalidRowStyle = computed(() =>
    messageEntry.key("kind").get() === "invalid"
      ? {
        borderLeft: "2px solid #dc2626",
        paddingLeft: "0.75rem",
      }
      : {}
  );
  const invalidVisibility = computed(() => ({
    display: messageEntry.key("kind").get() === "invalid" ? "block" : "none",
  }));
  const invalidClaimLabel = computed(() =>
    messageEntry.key("kind").get() === "invalid"
      ? `Claims to be from ${authorCell.key("name").get()}`
      : ""
  );

  return (
    <cf-vstack gap="1" style={invalidRowStyle}>
      <cf-hstack justify="between" align="center" wrap>
        <cf-label>{authorCell.key("slotLabel")}</cf-label>
        <div style={invalidVisibility}>
          <cf-badge variant="destructive">Invalid claim</cf-badge>
        </div>
      </cf-hstack>
      <cf-label style={invalidVisibility}>{invalidClaimLabel}</cf-label>
      <cf-cfc-authorship
        data-authorship-surface={messagePiece.key("id")}
        $value={messagePiece}
        $author={authorCell}
        verifyTextIntegrity
        allowLiteralText={false}
        requiredTextIntegrity={requiredTextIntegrity}
      >
        <cf-chat-message
          compact
          role={messageRole}
          name={authorCell.key("name")}
          content={messagePiece.key("body")}
        />
      </cf-cfc-authorship>
    </cf-vstack>
  );
});

const sortTranscriptEntries = (
  entries: readonly TranscriptMessageEntry[],
): TranscriptMessageEntry[] =>
  Array.from(entries).sort((left, right) =>
    left.piece.timestamp === right.piece.timestamp
      ? left.piece.id.localeCompare(right.piece.id)
      : left.piece.timestamp - right.piece.timestamp
  );

const SharedTranscript = pattern<
  SharedTranscriptInput,
  { [NAME]: string; [UI]: VNode }
>(({ messages, invalidMessages, viewerSlotId, id }) => {
  const orderedEntries = computed(() =>
    sortTranscriptEntries([
      ...messageEntriesValue(messages),
      ...invalidMessageEntriesValue(invalidMessages),
    ])
  );
  const messageCountLabel = computed(() => {
    const count = sortTranscriptEntries([
      ...messageEntriesValue(messages),
      ...invalidMessageEntriesValue(invalidMessages),
    ]).length;
    return count === 0
      ? "No messages yet"
      : `${count} message${count === 1 ? "" : "s"}`;
  });

  return {
    [NAME]: computed(() => `${id} shared transcript`),
    [UI]: (
      <cf-card id={id}>
        <cf-vstack slot="content" gap="3">
          <cf-label>{messageCountLabel}</cf-label>
          {orderedEntries.map((messageEntry) =>
            SharedTranscriptMessageRow({
              messageEntry,
              viewerSlotId,
            })
          )}
        </cf-vstack>
      </cf-card>
    ),
  };
});

export interface TrustedProfileSaveSurfaceInput {
  slotId: SlotId;
  nameDraft: Writable<string>;
  participants: SharedParticipantsCell;
}

export interface TrustedProfileSaveSurfaceOutput {
  [NAME]: string;
  [UI]: VNode;
  participants: SharedParticipantsValue;
  saveProfile: Stream<void>;
}

export const TrustedProfileSaveSurface = pattern<
  TrustedProfileSaveSurfaceInput,
  TrustedProfileSaveSurfaceOutput
>(({ slotId, nameDraft, participants }) => {
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
    [NAME]: computed(() => `${meta.label} trusted profile save`),
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
  invalidMessages: InvalidMessagesCell;
}

export interface TrustedChatSendSurfaceOutput {
  [NAME]: string;
  [UI]: VNode;
  messages: SharedMessagesValue;
  sendMessage: Stream<void>;
}

export const TrustedChatSendSurface = pattern<
  TrustedChatSendSurfaceInput,
  TrustedChatSendSurfaceOutput
>(({ slotId, messageDraft, participants, messages, invalidMessages }) => {
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
  const draftPreview = computed(() => {
    const saved = findParticipantBySlot(
      participantsValue(participants),
      slotId,
    );
    const trimmedDraft = messageDraft.get().trim();
    if (!trimmedDraft) {
      return "Type a message below.";
    }
    return saved
      ? `Ready to send as ${saved.name}: ${trimmedDraft}`
      : `Set your name before sending: ${trimmedDraft}`;
  });

  return {
    [NAME]: computed(() => `${metaForSlot(slotId).label} trusted send surface`),
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
          {SharedTranscript({
            messages,
            invalidMessages,
            viewerSlotId: slotId,
            id: `trusted-conversation-preview-${slotId}`,
          })}
          <cf-hstack justify="between" align="center" wrap gap="2">
            <cf-label id={`trusted-draft-preview-${slotId}`}>
              {draftPreview}
            </cf-label>
            <cf-button
              id={`trusted-send-button-${slotId}`}
              data-ui-action={TRUSTED_GROUP_CHAT_SEND_ACTION}
              size="sm"
              disabled={sendDisabled}
              onClick={sendMessage}
            >
              Trusted send
            </cf-button>
          </cf-hstack>
        </cf-vstack>
      </cf-card>
    ),
    messages,
    sendMessage,
  };
});

export interface ParticipantRoomInput {
  slotId: SlotId;
  participants: SharedParticipantsCell;
  messages: SharedMessagesCell;
  invalidMessages: InvalidMessagesCell;
  lobbyPiece: LobbyPiece | null | Default<null>;
}

export interface ParticipantRoomOutput {
  [NAME]: string;
  [UI]: VNode;
  slotId: SlotId;
  participants: SharedParticipantsValue;
  messages: SharedMessagesValue;
  setProfileDraft: Stream<string>;
  saveProfile: Stream<void>;
  setMessageDraft: Stream<string>;
  sendTrustedMessage: Stream<void>;
  invalidMessages: InvalidMessagesValue;
}

export const ParticipantRoom = pattern<
  ParticipantRoomInput,
  ParticipantRoomOutput
>(({ slotId, participants, messages, invalidMessages, lobbyPiece }) => {
  const meta = metaForSlot(slotId);
  const profileDraft = Writable.of("");
  const messageDraft = Writable.of("");
  const setProfileDraft = writeDraftText({ value: profileDraft });
  const setMessageDraft = writeDraftText({ value: messageDraft });
  const trustedProfileSave = TrustedProfileSaveSurface({
    slotId,
    nameDraft: profileDraft,
    participants,
  });
  const trustedSend = TrustedChatSendSurface({
    slotId,
    messageDraft,
    participants,
    messages,
    invalidMessages,
  });
  const currentProfileLabel = computed(() => {
    const saved = findParticipantBySlot(
      participantsValue(participants),
      slotId,
    );
    return saved ? saved.name : "Name not set";
  });
  const hostSendDisabled = computed(() =>
    messageDraft.get().trim().length === 0
  );
  const addRandomMessagesDisabled = computed(() =>
    participantsValue(participants).length === 0 ||
    (
        messageEntriesValue(messages).length +
        invalidMessageEntriesValue(invalidMessages).length
      ) === 0
  );
  const hostLookalikeSend = action(() => {
    // This ordinary host control intentionally cannot release the private draft.
  });
  const addRandomMessages = action(() => {
    const nextMessages = createRandomInvalidClaimedMessages(
      sortDisplayMessages([
        ...messageEntriesValue(messages).map((entry) =>
          entry.piece as DisplayChatMessage
        ),
        ...invalidMessageEntriesValue(invalidMessages).map((entry) =>
          entry.piece as DisplayChatMessage
        ),
      ]),
      participantsValue(participants),
    );
    nextMessages.forEach((message) =>
      invalidMessages.push({
        kind: "invalid",
        piece: message,
      })
    );
  });
  const goBackToLobby = action(() => {
    if (lobbyPiece) {
      return navigateTo(lobbyPiece);
    }
  });

  return {
    [NAME]: computed(() => `${meta.label} room`),
    [UI]: (
      <cf-screen title={`${meta.label} room`}>
        <cf-vstack gap="4" style={{ padding: "1rem" }}>
          <cf-hstack justify="between" align="center" wrap>
            <cf-vstack gap="1">
              <cf-heading level={2}>{meta.label}</cf-heading>
              <cf-label>Current name: {currentProfileLabel}</cf-label>
            </cf-vstack>
            {lobbyPiece
              ? (
                <cf-button
                  id={`back-to-lobby-${slotId}`}
                  variant="ghost"
                  onClick={goBackToLobby}
                >
                  Back to lobby
                </cf-button>
              )
              : null}
          </cf-hstack>
          {trustedProfileSave}
          {trustedSend}
          {SharedTranscript({
            messages,
            invalidMessages,
            viewerSlotId: slotId,
            id: `shared-transcript-${slotId}`,
          })}
          <cf-card id={`host-send-panel-${slotId}`}>
            <cf-hstack slot="content" gap="2" align="center" wrap>
              <cf-vgroup
                gap="sm"
                style={{ minWidth: "16rem", flex: "1 1 16rem" }}
              >
                <cf-input
                  id={`host-message-draft-${slotId}`}
                  size="sm"
                  $value={messageDraft}
                  placeholder="Write a message"
                />
              </cf-vgroup>
              <cf-button
                id={`host-send-button-${slotId}`}
                disabled={hostSendDisabled}
                onClick={hostLookalikeSend}
              >
                Send message
              </cf-button>
              <cf-button
                id={`add-random-invalid-${slotId}`}
                variant="ghost"
                size="sm"
                disabled={addRandomMessagesDisabled}
                onClick={addRandomMessages}
              >
                Add random invalid
              </cf-button>
            </cf-hstack>
          </cf-card>
        </cf-vstack>
      </cf-screen>
    ),
    slotId,
    participants,
    messages,
    invalidMessages,
    setProfileDraft,
    saveProfile: trustedProfileSave.saveProfile,
    setMessageDraft,
    sendTrustedMessage: trustedSend.sendMessage,
  };
});

export interface GroupChatDemoOutput {
  [NAME]: string;
  [UI]: VNode;
  participants: SharedParticipantsValue;
  messages: SharedMessagesValue;
  invalidMessages: InvalidMessagesValue;
}

export default pattern<unknown, GroupChatDemoOutput>(({ [SELF]: self }) => {
  const participants: SharedParticipantsCell = Writable.of<
    SharedParticipantsValue
  >([] as SharedParticipantsValue) as SharedParticipantsCell;
  const messages: SharedMessagesCell = Writable.of<SharedMessagesValue>(
    [] as SharedMessagesValue,
  ) as SharedMessagesCell;
  const invalidMessages: InvalidMessagesCell = Writable.of<
    InvalidMessagesValue
  >(
    [] as Default<[]>,
  ) as InvalidMessagesCell;
  const participantOneRoom = Writable.of<ParticipantRoomOutput | null>(null);
  const participantTwoRoom = Writable.of<ParticipantRoomOutput | null>(null);
  const participantThreeRoom = Writable.of<ParticipantRoomOutput | null>(null);

  const openParticipantOne = enterGroupChatRoom({
    slotId: "participant-1",
    roomRef: participantOneRoom,
    participants,
    messages,
    invalidMessages,
    lobbyPiece: self,
  });
  const openParticipantTwo = enterGroupChatRoom({
    slotId: "participant-2",
    roomRef: participantTwoRoom,
    participants,
    messages,
    invalidMessages,
    lobbyPiece: self,
  });
  const openParticipantThree = enterGroupChatRoom({
    slotId: "participant-3",
    roomRef: participantThreeRoom,
    participants,
    messages,
    invalidMessages,
    lobbyPiece: self,
  });

  return {
    [NAME]: "CFC group chat demo",
    [UI]: (
      <cf-screen title="CFC group chat demo">
        <cf-vstack gap="4" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={2}>Trusted send into a shared chat</cf-heading>
              <cf-label>
                The lobby and room shell are ordinary pattern code. Trusted
                profile save and trusted send surfaces are the only reviewed
                controls that can move local drafts into the shared group state.
              </cf-label>
              <cf-hstack gap="2" wrap>
                <cf-chip
                  label={computed(() =>
                    `${participantsValue(participants).length} trusted profile${
                      participantsValue(participants).length === 1 ? "" : "s"
                    }`
                  )}
                />
                <cf-chip
                  label={computed(() =>
                    `${
                      messageEntriesValue(messages).length +
                      invalidMessageEntriesValue(invalidMessages).length
                    } message${
                      (
                          messageEntriesValue(messages).length +
                          invalidMessageEntriesValue(invalidMessages).length
                        ) === 1
                        ? ""
                        : "s"
                    }`
                  )}
                />
              </cf-hstack>
            </cf-vstack>
          </cf-card>
          <cf-grid columns="3" gap="4">
            <cf-card id="lobby-slot-participant-1">
              <cf-vstack slot="content" gap="3">
                <cf-heading level={3}>Participant 1</cf-heading>
                {ParticipantStatusChip({
                  participants,
                  slotId: "participant-1",
                })}
                <cf-button
                  id="open-room-participant-1"
                  onClick={openParticipantOne}
                >
                  Open room
                </cf-button>
              </cf-vstack>
            </cf-card>
            <cf-card id="lobby-slot-participant-2">
              <cf-vstack slot="content" gap="3">
                <cf-heading level={3}>Participant 2</cf-heading>
                {ParticipantStatusChip({
                  participants,
                  slotId: "participant-2",
                })}
                <cf-button
                  id="open-room-participant-2"
                  onClick={openParticipantTwo}
                >
                  Open room
                </cf-button>
              </cf-vstack>
            </cf-card>
            <cf-card id="lobby-slot-participant-3">
              <cf-vstack slot="content" gap="3">
                <cf-heading level={3}>Participant 3</cf-heading>
                {ParticipantStatusChip({
                  participants,
                  slotId: "participant-3",
                })}
                <cf-button
                  id="open-room-participant-3"
                  onClick={openParticipantThree}
                >
                  Open room
                </cf-button>
              </cf-vstack>
            </cf-card>
          </cf-grid>
        </cf-vstack>
      </cf-screen>
    ),
    participants,
    messages,
    invalidMessages,
  };
});
