import {
  action,
  computed,
  Default,
  handler,
  NAME,
  pattern,
  type PerSession,
  type PerSpace,
  type PerUser,
  Stream,
  UI,
  Writable,
} from "commonfabric";
import {
  createRandomImportedClaimedMessages,
  findParticipantBySlot,
  metaForSlot,
  SLOT_IDS,
  type SlotId,
  sortDisplayMessages,
} from "./logic.ts";
import {
  activeSlotValue,
  commitTrustedMessageSend,
  messagesValue,
  participantsValue,
  type SharedChatMessage,
  type SharedMessagesCell,
  type SharedMessagesValue,
  type SharedParticipantsCell,
  type SharedParticipantsValue,
  type SlotSelectionCell,
  type SlotSelectionValue,
  TrustedChatSendSurface,
  TrustedProfileSaveSurface,
  VerifiedChatBubble,
} from "./trusted.tsx";

type DraftCell = Writable<string | Default<"">>;

const messageCountText = (count: number): string =>
  count === 0 ? "No messages yet" : `${count} message${count === 1 ? "" : "s"}`;

const draftText = (draft: DraftCell): string =>
  (draft.get() as string | undefined) ?? "";

const writeDraftText = handler<string, { value: DraftCell }>(
  (nextValue, { value }) => {
    value.set(nextValue);
  },
);

const writeActiveSlot = handler<SlotId, { activeSlot: SlotSelectionCell }>(
  (nextSlot, { activeSlot }) => {
    activeSlot.set(nextSlot);
  },
);

const selectSlot = handler<
  void,
  {
    activeSlot: SlotSelectionCell;
    slotId: SlotId;
  }
>((_, { activeSlot, slotId }) => {
  activeSlot.set(slotId);
});

interface SlotPickerInput {
  activeSlot: SlotSelectionCell;
  participants: SharedParticipantsCell;
}

const SlotPicker = pattern<SlotPickerInput, { [NAME]: string; [UI]: any }>((
  { activeSlot, participants }: SlotPickerInput,
): { [NAME]: string; [UI]: any } => ({
  [NAME]: "demo participant picker",
  [UI]: (
    <cf-hstack id="active-slot-picker" gap="2" wrap>
      {SLOT_IDS.map((slotId) => {
        const label = computed(() => {
          const saved = findParticipantBySlot(
            participantsValue(participants),
            slotId,
          );
          return saved ? saved.name : metaForSlot(slotId).label;
        });
        return (
          <cf-button
            id={`select-slot-${slotId}`}
            variant={computed(() =>
              activeSlotValue(activeSlot) === slotId ? "primary" : "secondary"
            )}
            onClick={selectSlot({ activeSlot, slotId })}
          >
            {label}
          </cf-button>
        );
      })}
    </cf-hstack>
  ),
}));

interface SharedTranscriptInput {
  messages: SharedMessagesCell;
  id: string;
}

const SharedTranscript = pattern<
  SharedTranscriptInput,
  { [NAME]: string; [UI]: any }
>((
  { messages, id }: SharedTranscriptInput,
): { [NAME]: string; [UI]: any } => {
  const messageCountLabel = computed(() => {
    return messageCountText(messagesValue(messages).length);
  });
  const transcriptRows = messages.map((messageCell) => (
    <div style={{ width: "min(34rem, 100%)" }}>
      {VerifiedChatBubble({
        message: messageCell,
      })}
    </div>
  ));

  return {
    [NAME]: computed(() => `${id} transcript`),
    [UI]: (
      <cf-vstack id={id} gap="3" style={{ minHeight: 0 }}>
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
          {transcriptRows}
        </div>
      </cf-vstack>
    ),
  };
});

export interface GroupChatDemoInput {
  participants?: PerSpace<SharedParticipantsCell>;
  messages?: PerSpace<SharedMessagesCell>;
  activeSlot?: PerUser<SlotSelectionCell>;
  profileDraft?: PerUser<DraftCell>;
  messageDraft?: PerUser<DraftCell>;
  hostMessageDraft?: PerSession<DraftCell>;
}

export interface GroupChatDemoOutput {
  [NAME]: string;
  [UI]: any;
  participants: PerSpace<SharedParticipantsCell>;
  messages: PerSpace<SharedMessagesCell>;
  activeSlot: PerUser<SlotSelectionCell>;
  profileDraft: PerUser<DraftCell>;
  messageDraft: PerUser<DraftCell>;
  hostMessageDraft: PerSession<DraftCell>;
  setActiveSlot: Stream<SlotId>;
  setProfileDraft: Stream<string>;
  setMessageDraft: Stream<string>;
  setHostMessageDraft: Stream<string>;
  saveProfile: Stream<void>;
  sendTrustedMessage: Stream<void>;
}

export const GroupChatDemo = pattern<GroupChatDemoInput, GroupChatDemoOutput>((
  {
    participants,
    messages,
    activeSlot,
    profileDraft,
    messageDraft,
    hostMessageDraft,
  }: GroupChatDemoInput,
): GroupChatDemoOutput => {
  const participantsCell = participants as SharedParticipantsCell;
  const messagesCell = messages as SharedMessagesCell;
  const activeSlotCell = activeSlot as SlotSelectionCell;
  const profileDraftCell = profileDraft as DraftCell;
  const messageDraftCell = messageDraft as DraftCell;
  const hostMessageDraftCell = hostMessageDraft as DraftCell;
  const trustedProfileSave = TrustedProfileSaveSurface({
    slotId: activeSlotCell,
    nameDraft: profileDraftCell,
    participants: participantsCell,
  });
  const trustedSend = TrustedChatSendSurface({
    slotId: activeSlotCell,
    messageDraft: messageDraftCell,
    participants: participantsCell,
    messages: messagesCell,
  });
  const hostLookalikeSend = commitTrustedMessageSend({
    slotId: activeSlotCell,
    messageDraft: hostMessageDraftCell,
    participants: participantsCell,
    messages: messagesCell,
  });
  const setActiveSlot = writeActiveSlot({ activeSlot: activeSlotCell });
  const setProfileDraft = writeDraftText({ value: profileDraftCell });
  const setMessageDraft = writeDraftText({ value: messageDraftCell });
  const setHostMessageDraft = writeDraftText({ value: hostMessageDraftCell });
  const activeSlotLabel = computed(() =>
    metaForSlot(activeSlotValue(activeSlotCell)).label
  );
  const currentProfileLabel = computed(() => {
    const saved = findParticipantBySlot(
      participantsValue(participantsCell),
      activeSlotValue(activeSlotCell),
    );
    return saved ? saved.name : "Name not set";
  });
  const hostSendDisabled = computed(() =>
    draftText(hostMessageDraftCell).trim().length === 0
  );
  const addRandomMessagesDisabled = computed(() =>
    participantsValue(participantsCell).length === 0 ||
    messagesValue(messagesCell).length === 0
  );
  const addRandomMessages = action(() => {
    const nextMessages = createRandomImportedClaimedMessages(
      sortDisplayMessages(messagesValue(messagesCell)),
      participantsValue(participantsCell),
    );
    nextMessages.forEach((message) =>
      messagesCell.push(message as SharedChatMessage)
    );
  });

  return {
    [NAME]: "CFC group chat demo",
    [UI]: (
      <cf-screen title="CFC group chat demo">
        <cf-vstack
          id="group-chat-demo"
          gap="4"
          style={{
            height: "100%",
            minHeight: "0",
            padding: "1rem",
          }}
        >
          <cf-card>
            <cf-vstack slot="content" gap="3">
              <cf-hstack justify="between" align="start" wrap gap="3">
                <cf-vstack gap="1">
                  <cf-heading level={2}>Group chat</cf-heading>
                  <cf-label>
                    The chat shell is ordinary pattern code. Small reviewed
                    components save profiles, send messages, and render verified
                    author bubbles.
                  </cf-label>
                </cf-vstack>
                <cf-hstack gap="2" wrap>
                  <cf-chip
                    label={computed(() =>
                      `${participantsValue(participantsCell).length} profile${
                        participantsValue(participantsCell).length === 1
                          ? ""
                          : "s"
                      }`
                    )}
                  />
                  <cf-chip
                    label={computed(() =>
                      messageCountText(messagesValue(messagesCell).length)
                    )}
                  />
                </cf-hstack>
              </cf-hstack>
              <cf-vstack gap="2">
                <cf-label>Demo participant for this user</cf-label>
                {SlotPicker({
                  activeSlot: activeSlotCell,
                  participants: participantsCell,
                })}
                <cf-label id="current-profile-label">
                  Acting as {activeSlotLabel}: {currentProfileLabel}
                </cf-label>
              </cf-vstack>
            </cf-vstack>
          </cf-card>

          {trustedProfileSave}

          <cf-card id="chat-panel">
            <cf-vstack slot="content" gap="3" style={{ minHeight: 0 }}>
              {SharedTranscript({
                messages: messagesCell,
                id: "trusted-conversation-preview",
              })}
              {trustedSend}
            </cf-vstack>
          </cf-card>

          <cf-card id="host-send-panel">
            <cf-hstack slot="content" gap="2" align="center" wrap>
              <cf-vgroup
                gap="sm"
                style={{ minWidth: "16rem", flex: "1 1 16rem" }}
              >
                <cf-input
                  id="host-message-draft"
                  size="sm"
                  $value={hostMessageDraft}
                  placeholder="Write a message"
                />
              </cf-vgroup>
              <cf-button
                id="host-send-button"
                disabled={hostSendDisabled}
                onClick={hostLookalikeSend}
              >
                Send
              </cf-button>
            </cf-hstack>
          </cf-card>

          <cf-button
            id="add-random-messages"
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
    participants: participantsCell as PerSpace<SharedParticipantsCell>,
    messages: messagesCell as PerSpace<SharedMessagesCell>,
    activeSlot: activeSlotCell as PerUser<SlotSelectionCell>,
    profileDraft: profileDraftCell as PerUser<DraftCell>,
    messageDraft: messageDraftCell as PerUser<DraftCell>,
    hostMessageDraft: hostMessageDraftCell as PerSession<DraftCell>,
    setActiveSlot,
    setProfileDraft,
    setMessageDraft,
    setHostMessageDraft,
    saveProfile: trustedProfileSave.saveProfile,
    sendTrustedMessage: trustedSend.sendMessage,
  };
});

export default GroupChatDemo;

export type {
  SharedMessagesValue,
  SharedParticipantsValue,
  SlotSelectionValue,
};
