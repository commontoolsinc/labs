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
  sortDisplayMessages,
} from "./logic.ts";
import {
  commitTrustedMessageSend,
  currentProfileCell,
  messagesValue,
  type MyProfileCell,
  participantClaimsValue,
  sameProfileCell,
  type SharedChatMessage,
  type SharedMessagesCell,
  type SharedMessagesValue,
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

interface SharedTranscriptInput {
  myProfile: MyProfileCell;
  messages: SharedMessagesCell;
  id: string;
}

const SharedTranscript = pattern<
  SharedTranscriptInput,
  { [NAME]: string; [UI]: any }
>((
  { myProfile, messages, id }: SharedTranscriptInput,
): { [NAME]: string; [UI]: any } => {
  const messageCountLabel = computed(() =>
    messageCountText(messagesValue(messages).length)
  );
  const transcriptRows = messages.map((messageCell) => {
    const authorProfile = messageCell.authorProfile;
    const isMine = computed(() =>
      sameProfileCell(currentProfileCell(myProfile), authorProfile)
    );
    return (
      <div
        style={{
          display: "flex",
          width: "100%",
          justifyContent: isMine ? "flex-end" : "flex-start",
        }}
      >
        <div style={{ width: "min(34rem, 100%)" }}>
          {VerifiedChatBubble({
            message: messageCell,
          })}
        </div>
      </div>
    );
  });

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
  myProfile?: PerUser<MyProfileCell>;
  messages?: PerSpace<SharedMessagesCell>;
  profileDraft?: PerUser<DraftCell>;
  messageDraft?: PerUser<DraftCell>;
  hostMessageDraft?: PerSession<DraftCell>;
}

export interface GroupChatDemoOutput {
  [NAME]: string;
  [UI]: any;
  myProfile: PerUser<MyProfileCell>;
  messages: PerSpace<SharedMessagesCell>;
  profileDraft: PerUser<DraftCell>;
  messageDraft: PerUser<DraftCell>;
  hostMessageDraft: PerSession<DraftCell>;
  setProfileDraft: Stream<string>;
  setMessageDraft: Stream<string>;
  setHostMessageDraft: Stream<string>;
  currentProfileName: string;
  saveProfile: Stream<void>;
  sendTrustedMessage: Stream<void>;
  hostLookalikeSend: Stream<void>;
  addRandomMessages: Stream<void>;
}

export const GroupChatDemo = pattern<GroupChatDemoInput, GroupChatDemoOutput>((
  {
    myProfile,
    messages,
    profileDraft,
    messageDraft,
    hostMessageDraft,
  }: GroupChatDemoInput,
): GroupChatDemoOutput => {
  const myProfileCell = myProfile as MyProfileCell;
  const messagesCell = messages as SharedMessagesCell;
  const profileDraftCell = profileDraft as DraftCell;
  const messageDraftCell = messageDraft as DraftCell;
  const hostMessageDraftCell = hostMessageDraft as DraftCell;
  const trustedProfileSave = TrustedProfileSaveSurface({
    myProfile: myProfileCell,
    nameDraft: profileDraftCell,
  });
  const trustedSend = TrustedChatSendSurface({
    myProfile: myProfileCell,
    messageDraft: messageDraftCell,
    messages: messagesCell as any,
  });
  const hostLookalikeSend = commitTrustedMessageSend({
    myProfile: myProfileCell,
    messageDraft: hostMessageDraftCell,
    messages: messagesCell as any,
  });
  const setProfileDraft = writeDraftText({ value: profileDraftCell });
  const setMessageDraft = writeDraftText({ value: messageDraftCell });
  const setHostMessageDraft = writeDraftText({ value: hostMessageDraftCell });
  const participantCountLabel = computed(() => {
    const count = participantClaimsValue(myProfileCell, messagesCell).length;
    return `${count} participant${count === 1 ? "" : "s"}`;
  });
  const hostSendDisabled = computed(() =>
    draftText(hostMessageDraftCell).trim().length === 0
  );
  const addRandomMessagesDisabled = computed(() =>
    participantClaimsValue(myProfileCell, messagesCell).length === 0 ||
    messagesValue(messagesCell).length === 0
  );
  const addRandomMessages = action(() => {
    const nextMessages = createRandomImportedClaimedMessages(
      sortDisplayMessages(messagesValue(messagesCell)),
      participantClaimsValue(myProfileCell, messagesCell),
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
                    Ordinary chat layout built from small reviewed CFC surfaces.
                  </cf-label>
                </cf-vstack>
                <cf-hstack gap="2" wrap>
                  <cf-chip
                    label={participantCountLabel}
                  />
                  <cf-chip
                    label={computed(() =>
                      messageCountText(messagesValue(messagesCell).length)
                    )}
                  />
                </cf-hstack>
              </cf-hstack>
            </cf-vstack>
          </cf-card>

          {trustedProfileSave}

          <cf-card id="chat-panel">
            <cf-vstack slot="content" gap="3" style={{ minHeight: 0 }}>
              {SharedTranscript({
                myProfile: myProfileCell,
                messages: messagesCell as any,
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
    myProfile: myProfileCell as PerUser<MyProfileCell>,
    messages: messagesCell as PerSpace<SharedMessagesCell>,
    profileDraft: profileDraftCell as PerUser<DraftCell>,
    messageDraft: messageDraftCell as PerUser<DraftCell>,
    hostMessageDraft: hostMessageDraftCell as PerSession<DraftCell>,
    setProfileDraft,
    setMessageDraft,
    setHostMessageDraft,
    currentProfileName: trustedProfileSave.currentProfileName,
    saveProfile: trustedProfileSave.saveProfile,
    sendTrustedMessage: trustedSend.sendMessage,
    hostLookalikeSend,
    addRandomMessages,
  };
});

export default GroupChatDemo;

export type { SharedMessagesValue };
