import {
  action,
  computed,
  Default,
  handler,
  NAME,
  navigateTo,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import {
  createRandomImportedClaimedMessages,
  findParticipantBySlot,
  metaForSlot,
  type SlotId,
  sortDisplayMessages,
} from "./logic.ts";
import {
  commitTrustedMessageSend,
  messagesValue,
  participantsValue,
  type SharedChatMessage,
  type SharedMessagesCell,
  type SharedMessagesValue,
  type SharedParticipantsCell,
  type SharedParticipantsValue,
  TrustedChatSendSurface,
  TrustedProfileSaveSurface,
  VerifiedChatBubble,
  VerifiedChatBubble1,
  VerifiedChatBubble2,
  VerifiedChatBubble3,
} from "./trusted.tsx";

type LobbyPiece = { [NAME]?: string };

const writeDraftText = handler<string, { value: Writable<string> }>(
  (nextValue, { value }) => {
    value.set(nextValue);
  },
);

const messageCountText = (count: number): string =>
  count === 0 ? "No messages yet" : `${count} message${count === 1 ? "" : "s"}`;

const sharedWritableOf = <Value,>(
  value: Value,
  name: string,
): Writable<Value> => Writable.of<Value>(value).for(name);

interface ParticipantStatusChipInput {
  participants: SharedParticipantsCell;
  slotId: SlotId;
}

const ParticipantStatusChip = pattern<
  ParticipantStatusChipInput,
  { [NAME]: string; [UI]: any }
>((
  { participants, slotId }: ParticipantStatusChipInput,
): { [NAME]: string; [UI]: any } => {
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

interface SharedTranscriptInput {
  messages: SharedMessagesCell;
  viewerSlotId: SlotId;
  id: string;
}

const SharedTranscript = pattern<
  SharedTranscriptInput,
  { [NAME]: string; [UI]: any }
>((
  { messages, viewerSlotId, id }: SharedTranscriptInput,
): { [NAME]: string; [UI]: any } => {
  const messageCountLabel = computed(() =>
    messageCountText(messagesValue(messages).length)
  );
  const rowZeroStyle = computed(() => {
    const message = messagesValue(messages)[0];
    const orderedIds = sortDisplayMessages(messagesValue(messages)).map(
      (entry) => entry.id,
    );
    const order = message ? orderedIds.indexOf(message.id) : 0;
    return {
      display: message ? "block" : "none",
      order: order < 0 ? 0 : order,
      alignSelf: message?.author.id === viewerSlotId
        ? "flex-end"
        : "flex-start",
      width: "min(34rem, 100%)",
    };
  });
  const rowOneStyle = computed(() => {
    const message = messagesValue(messages)[1];
    const orderedIds = sortDisplayMessages(messagesValue(messages)).map(
      (entry) => entry.id,
    );
    const order = message ? orderedIds.indexOf(message.id) : 1;
    return {
      display: message ? "block" : "none",
      order: order < 0 ? 1 : order,
      alignSelf: message?.author.id === viewerSlotId
        ? "flex-end"
        : "flex-start",
      width: "min(34rem, 100%)",
    };
  });
  const rowTwoStyle = computed(() => {
    const message = messagesValue(messages)[2];
    const orderedIds = sortDisplayMessages(messagesValue(messages)).map(
      (entry) => entry.id,
    );
    const order = message ? orderedIds.indexOf(message.id) : 2;
    return {
      display: message ? "block" : "none",
      order: order < 0 ? 2 : order,
      alignSelf: message?.author.id === viewerSlotId
        ? "flex-end"
        : "flex-start",
      width: "min(34rem, 100%)",
    };
  });
  const rowThreeStyle = computed(() => {
    const message = messagesValue(messages)[3];
    const orderedIds = sortDisplayMessages(messagesValue(messages)).map(
      (entry) => entry.id,
    );
    const order = message ? orderedIds.indexOf(message.id) : 3;
    return {
      display: message ? "block" : "none",
      order: order < 0 ? 3 : order,
      alignSelf: message?.author.id === viewerSlotId
        ? "flex-end"
        : "flex-start",
      width: "min(34rem, 100%)",
    };
  });

  return {
    [NAME]: computed(() => `${id} transcript`),
    [UI]: (
      <cf-vstack id={id} gap="3">
        <cf-label>{messageCountLabel}</cf-label>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.75rem",
            maxHeight: "min(52vh, 32rem)",
            overflowY: "auto",
            overscrollBehavior: "contain",
            paddingRight: "0.25rem",
          }}
        >
          <div style={rowZeroStyle}>
            {VerifiedChatBubble({ messages, viewerSlotId })}
          </div>
          <div style={rowOneStyle}>
            {VerifiedChatBubble1({ messages, viewerSlotId })}
          </div>
          <div style={rowTwoStyle}>
            {VerifiedChatBubble2({ messages, viewerSlotId })}
          </div>
          <div style={rowThreeStyle}>
            {VerifiedChatBubble3({ messages, viewerSlotId })}
          </div>
        </div>
      </cf-vstack>
    ),
  };
});

export interface ParticipantRoomInput {
  slotId: SlotId;
  participants: SharedParticipantsCell;
  messages: SharedMessagesCell;
  lobbyPiece: LobbyPiece | null | Default<null>;
}

export interface ParticipantRoomOutput {
  [NAME]: string;
  [UI]: any;
  slotId: SlotId;
  setProfileDraft: Stream<string>;
  saveProfile: Stream<void>;
  setMessageDraft: Stream<string>;
  sendTrustedMessage: Stream<void>;
}

export const ParticipantRoom = pattern<
  ParticipantRoomInput,
  ParticipantRoomOutput
>((
  { slotId, participants, messages, lobbyPiece }: ParticipantRoomInput,
): ParticipantRoomOutput => {
  const meta = metaForSlot(slotId);
  const profileDraft = Writable.of("");
  const trustedMessageDraft = Writable.of("");
  const hostMessageDraft = Writable.of("");
  const setProfileDraft = writeDraftText({ value: profileDraft });
  const setMessageDraft = writeDraftText({ value: trustedMessageDraft });
  const trustedProfileSave = TrustedProfileSaveSurface({
    slotId,
    nameDraft: profileDraft,
    participants,
  });
  const trustedSend = TrustedChatSendSurface({
    slotId,
    messageDraft: trustedMessageDraft,
    participants,
    messages,
  });
  const currentProfileLabel = computed(() => {
    const saved = findParticipantBySlot(
      participantsValue(participants),
      slotId,
    );
    return saved ? saved.name : "Name not set";
  });
  const hostLookalikeSend = commitTrustedMessageSend({
    slotId,
    messageDraft: hostMessageDraft,
    participants,
    messages,
  });
  const hostSendDisabled = computed(() =>
    hostMessageDraft.get().trim().length === 0
  );
  const addRandomMessagesDisabled = computed(() =>
    participantsValue(participants).length === 0 ||
    messagesValue(messages).length === 0
  );
  const addRandomMessages = action(() => {
    const nextMessages = createRandomImportedClaimedMessages(
      sortDisplayMessages(messagesValue(messages)),
      participantsValue(participants),
    );
    nextMessages.forEach((message) =>
      messages.push(message as SharedChatMessage)
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
          <cf-card id={`chat-panel-${slotId}`}>
            <cf-vstack slot="content" gap="3">
              {SharedTranscript({
                messages,
                viewerSlotId: slotId,
                id: `trusted-conversation-preview-${slotId}`,
              })}
              {trustedSend}
            </cf-vstack>
          </cf-card>
          <cf-card id={`host-send-panel-${slotId}`}>
            <cf-hstack slot="content" gap="2" align="center" wrap>
              <cf-vgroup
                gap="sm"
                style={{ minWidth: "16rem", flex: "1 1 16rem" }}
              >
                <cf-input
                  id={`host-message-draft-${slotId}`}
                  size="sm"
                  $value={hostMessageDraft}
                  placeholder="Write a message"
                />
              </cf-vgroup>
              <cf-button
                id={`host-send-button-${slotId}`}
                disabled={hostSendDisabled}
                onClick={hostLookalikeSend}
              >
                Send
              </cf-button>
            </cf-hstack>
          </cf-card>
          <cf-button
            id={`add-random-messages-${slotId}`}
            size="lg"
            style={{ width: "100%" }}
            disabled={addRandomMessagesDisabled}
            onClick={addRandomMessages}
          >
            Insert fake messages
          </cf-button>
        </cf-vstack>
      </cf-screen>
    ),
    slotId,
    setProfileDraft,
    saveProfile: trustedProfileSave.saveProfile,
    setMessageDraft,
    sendTrustedMessage: trustedSend.sendMessage,
  };
});

export interface GroupChatDemoOutput {
  [NAME]: string;
  [UI]: VNode;
}

export default pattern<unknown, GroupChatDemoOutput>(() => {
  const participants = sharedWritableOf<SharedParticipantsValue>(
    [] as SharedParticipantsValue,
    "participants",
  ) as SharedParticipantsCell;
  const messages = sharedWritableOf<SharedMessagesValue>(
    [] as SharedMessagesValue,
    "messages",
  ) as SharedMessagesCell;
  const participantOneRoom = ParticipantRoom({
    slotId: "participant-1",
    participants,
    messages,
    lobbyPiece: null,
  });
  const participantTwoRoom = ParticipantRoom({
    slotId: "participant-2",
    participants,
    messages,
    lobbyPiece: null,
  });
  const participantThreeRoom = ParticipantRoom({
    slotId: "participant-3",
    participants,
    messages,
    lobbyPiece: null,
  });

  return {
    [NAME]: "CFC group chat demo",
    [UI]: (
      <cf-screen title="CFC group chat demo">
        <cf-vstack gap="4" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={2}>Group chat</cf-heading>
              <cf-label>
                The chat shell is ordinary pattern code. Small reviewed
                components save profiles, send messages, and render verified
                author bubbles.
              </cf-label>
              <cf-hstack gap="2" wrap>
                <cf-chip
                  label={computed(() =>
                    `${participantsValue(participants).length} profile${
                      participantsValue(participants).length === 1 ? "" : "s"
                    }`
                  )}
                />
                <cf-chip
                  label={computed(() =>
                    messageCountText(messagesValue(messages).length)
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
              </cf-vstack>
            </cf-card>
            <cf-card id="lobby-slot-participant-2">
              <cf-vstack slot="content" gap="3">
                <cf-heading level={3}>Participant 2</cf-heading>
                {ParticipantStatusChip({
                  participants,
                  slotId: "participant-2",
                })}
              </cf-vstack>
            </cf-card>
            <cf-card id="lobby-slot-participant-3">
              <cf-vstack slot="content" gap="3">
                <cf-heading level={3}>Participant 3</cf-heading>
                {ParticipantStatusChip({
                  participants,
                  slotId: "participant-3",
                })}
              </cf-vstack>
            </cf-card>
          </cf-grid>
          <cf-grid columns="3" gap="4">
            {participantOneRoom}
            {participantTwoRoom}
            {participantThreeRoom}
          </cf-grid>
        </cf-vstack>
      </cf-screen>
    ),
  };
});
