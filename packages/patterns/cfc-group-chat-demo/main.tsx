import {
  action,
  computed,
  Default,
  equals,
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
  type AdminManagerCredentialCell,
  type AdminManagerDraftCell,
  type ChatAdminManagerCredential,
  type ChatAdminRegistryCell,
  type ChatAdminRegistryValue,
  commitTrustedMessageSend,
  currentProfileCell,
  currentUserIsAdmin as currentProfileIsAdmin,
  messagesValue,
  type MyProfileCell,
  participantClaimsValue,
  type RoomDraftCell,
  roomsValue,
  type SharedChatMessage,
  type SharedMessagesCell,
  type SharedMessagesValue,
  type SharedRoomsCell,
  type SharedRoomsValue,
  TrustedAdminPanel,
  TrustedChatSendSurface,
  TrustedProfileSaveSurface,
  TrustedRoomAddSurface,
} from "./trusted.tsx";

type DraftCell = Writable<string | Default<"">>;

const messageCountText = (count: number): string =>
  count === 0 ? "No messages yet" : `${count} message${count === 1 ? "" : "s"}`;

const roomCountText = (count: number): string =>
  count === 0 ? "No rooms yet" : `${count} room${count === 1 ? "" : "s"}`;

const draftText = (draft: DraftCell): string =>
  (draft.get() as string | undefined) ?? "";

const writeDraftText = handler<string, { value: DraftCell }>(
  (nextValue, { value }) => {
    value.set(nextValue);
  },
);

const writeBooleanDraft = handler<boolean, { value: AdminManagerDraftCell }>(
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
      equals(currentProfileCell(myProfile), authorProfile)
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
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: isMine ? "flex-end" : "flex-start",
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
              {messageCell.authorName}
            </span>
            <cf-cfc-authorship
              data-authorship-surface={messageCell.id}
              $value={messageCell.body}
              $author={messageCell.authorProfile}
              authorName={messageCell.authorName}
              data-badge-placement={isMine ? "end" : "start"}
            >
              <span
                style={{
                  display: "inline-block",
                  maxWidth: "100%",
                  padding: "8px 10px",
                  borderRadius: isMine
                    ? "14px 14px 4px 14px"
                    : "14px 14px 14px 4px",
                  background: isMine
                    ? "var(--cf-color-primary, #2563eb)"
                    : "var(--cf-color-surface-raised, #f3f4f6)",
                  color: isMine
                    ? "var(--cf-color-on-primary, #ffffff)"
                    : "var(--cf-color-text, #111827)",
                  overflowWrap: "anywhere",
                  whiteSpace: "pre-wrap",
                }}
              >
                {messageCell.body}
              </span>
            </cf-cfc-authorship>
          </div>
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
type SharedTranscriptInputArg = Parameters<typeof SharedTranscript>[0];

interface RoomsListInput {
  rooms: SharedRoomsCell;
  id: string;
}

const RoomsList = pattern<RoomsListInput, { [NAME]: string; [UI]: any }>((
  { rooms, id }: RoomsListInput,
): { [NAME]: string; [UI]: any } => {
  const roomListText = computed(() => {
    const names = roomsValue(rooms).map((room) => room.name);
    return names.length === 0 ? "No rooms yet" : names.join(" · ");
  });

  return {
    [NAME]: computed(() => `${id} rooms`),
    [UI]: (
      <cf-hstack id={id} gap="2" wrap>
        <cf-chip
          label={roomListText}
          variant="accent"
        />
      </cf-hstack>
    ),
  };
});
type RoomsListInputArg = Parameters<typeof RoomsList>[0];

type TrustedChatSendSurfaceInputArg = Parameters<
  typeof TrustedChatSendSurface
>[0];
type TrustedAdminPanelInputArg = Parameters<typeof TrustedAdminPanel>[0];
type TrustedRoomAddSurfaceInputArg = Parameters<
  typeof TrustedRoomAddSurface
>[0];
type TrustedMessageSendInputArg = Parameters<typeof commitTrustedMessageSend>[
  0
];

export interface GroupChatDemoInput {
  myProfile?: PerUser<MyProfileCell>;
  messages?: PerSpace<SharedMessagesCell>;
  rooms?: PerSpace<SharedRoomsCell>;
  adminRegistry?: PerSpace<ChatAdminRegistryCell>;
  profileDraft?: PerUser<DraftCell>;
  adminDraft?: PerUser<AdminManagerDraftCell>;
  messageDraft?: PerUser<DraftCell>;
  hostMessageDraft?: PerSession<DraftCell>;
  roomDraft?: PerSession<RoomDraftCell>;
}

export interface GroupChatDemoOutput {
  [NAME]: string;
  [UI]: any;
  myProfile: PerUser<MyProfileCell>;
  messages: PerSpace<SharedMessagesCell>;
  rooms: PerSpace<SharedRoomsCell>;
  adminRegistry: PerSpace<ChatAdminRegistryCell>;
  profileDraft: PerUser<DraftCell>;
  adminDraft: PerUser<AdminManagerDraftCell>;
  messageDraft: PerUser<DraftCell>;
  hostMessageDraft: PerSession<DraftCell>;
  roomDraft: PerSession<RoomDraftCell>;
  setProfileDraft: Stream<string>;
  setAdminDraft: Stream<boolean>;
  setMessageDraft: Stream<string>;
  setHostMessageDraft: Stream<string>;
  setRoomDraft: Stream<string>;
  currentProfileName: string;
  currentUserIsAdmin: boolean;
  currentUserCanManageAdmins: boolean;
  saveProfile: Stream<void>;
  toggleCurrentUserAdmin: Stream<void>;
  sendTrustedMessage: Stream<void>;
  addTrustedRoom: Stream<void>;
  hostLookalikeSend: Stream<void>;
  addRandomMessages: Stream<void>;
}

export const GroupChatDemo = pattern<GroupChatDemoInput, GroupChatDemoOutput>((
  {
    myProfile,
    messages,
    rooms,
    adminRegistry,
    profileDraft,
    adminDraft,
    messageDraft,
    hostMessageDraft,
    roomDraft,
  }: GroupChatDemoInput,
): GroupChatDemoOutput => {
  const myProfileCell = myProfile as MyProfileCell;
  const adminManagerCredentialCell = new Writable.perUser<
    ChatAdminManagerCredential | null
  >(null) as AdminManagerCredentialCell;
  const messagesCell = messages as SharedMessagesCell;
  const roomsCell = rooms as SharedRoomsCell;
  const adminRegistryCell = adminRegistry as ChatAdminRegistryCell;
  const profileDraftCell = profileDraft as DraftCell;
  const adminManagerDraftCell = adminDraft as AdminManagerDraftCell;
  const messageDraftCell = messageDraft as DraftCell;
  const hostMessageDraftCell = hostMessageDraft as DraftCell;
  const roomDraftCell = roomDraft as RoomDraftCell;
  const trustedProfileSave = TrustedProfileSaveSurface({
    myProfile: myProfileCell,
    adminManagerCredential: adminManagerCredentialCell,
    nameDraft: profileDraftCell,
    adminManagerDraft: adminManagerDraftCell,
  });
  const currentUserCanManageAdminsStatus =
    trustedProfileSave.currentUserCanManageAdmins;
  const trustedAdminPanel = TrustedAdminPanel({
    myProfile: myProfileCell,
    messages: messagesCell,
    adminRegistry: adminRegistryCell,
    adminManagerCredential: adminManagerCredentialCell,
  } as TrustedAdminPanelInputArg);
  const trustedSend = TrustedChatSendSurface({
    myProfile: myProfileCell,
    messageDraft: messageDraftCell,
    messages: messagesCell,
  } as TrustedChatSendSurfaceInputArg);
  const trustedRoomAdd = TrustedRoomAddSurface({
    myProfile: myProfileCell,
    adminRegistry: adminRegistryCell,
    roomDraft: roomDraftCell,
    rooms: roomsCell,
  } as TrustedRoomAddSurfaceInputArg);
  const hostLookalikeSend = commitTrustedMessageSend({
    myProfile: myProfileCell,
    messageDraft: hostMessageDraftCell,
    messages: messagesCell,
  } as TrustedMessageSendInputArg);
  const setProfileDraft = writeDraftText({ value: profileDraftCell });
  const setAdminDraft = writeBooleanDraft({ value: adminManagerDraftCell });
  const setMessageDraft = writeDraftText({ value: messageDraftCell });
  const setHostMessageDraft = writeDraftText({ value: hostMessageDraftCell });
  const setRoomDraft = writeDraftText({ value: roomDraftCell });
  const participantCountLabel = computed(() => {
    const count = participantClaimsValue(myProfileCell, messagesCell).length;
    return `${count} participant${count === 1 ? "" : "s"}`;
  });
  const roomCountLabel = computed(() =>
    roomCountText(roomsValue(roomsCell).length)
  );
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
                  <cf-chip
                    label={roomCountLabel}
                  />
                  <cf-chip
                    label={computed(() =>
                      currentProfileIsAdmin(myProfileCell, adminRegistryCell)
                        ? "Admin enabled"
                        : "Admin off"
                    )}
                  />
                  <cf-chip
                    id="group-chat-manager-chip"
                    label={currentUserCanManageAdminsStatus
                      ? "Can manage admins"
                      : "Manager off"}
                  />
                </cf-hstack>
              </cf-hstack>
            </cf-vstack>
          </cf-card>

          {trustedProfileSave}
          {trustedAdminPanel}

          <cf-card id="rooms-panel">
            <cf-vstack slot="content" gap="3">
              <cf-hstack justify="between" align="center" wrap gap="2">
                <cf-vstack gap="1">
                  <cf-heading level={3}>Rooms</cf-heading>
                  <cf-label>{roomCountLabel}</cf-label>
                </cf-vstack>
              </cf-hstack>
              {RoomsList({
                rooms: roomsCell,
                id: "trusted-room-list",
              } as RoomsListInputArg)}
              {trustedRoomAdd}
            </cf-vstack>
          </cf-card>

          <cf-card id="chat-panel">
            <cf-vstack slot="content" gap="3" style={{ minHeight: 0 }}>
              {SharedTranscript({
                myProfile: myProfileCell,
                messages: messagesCell,
                id: "trusted-conversation-preview",
              } as SharedTranscriptInputArg)}
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
    rooms: roomsCell as PerSpace<SharedRoomsCell>,
    adminRegistry: adminRegistryCell as PerSpace<ChatAdminRegistryCell>,
    profileDraft: profileDraftCell as PerUser<DraftCell>,
    adminDraft: adminManagerDraftCell as PerUser<AdminManagerDraftCell>,
    messageDraft: messageDraftCell as PerUser<DraftCell>,
    hostMessageDraft: hostMessageDraftCell as PerSession<DraftCell>,
    roomDraft: roomDraftCell as PerSession<RoomDraftCell>,
    setProfileDraft,
    setAdminDraft,
    setMessageDraft,
    setHostMessageDraft,
    setRoomDraft,
    currentProfileName: trustedProfileSave.currentProfileName,
    currentUserIsAdmin: computed(() =>
      currentProfileIsAdmin(myProfileCell, adminRegistryCell)
    ),
    currentUserCanManageAdmins: currentUserCanManageAdminsStatus,
    saveProfile: trustedProfileSave.saveProfile,
    toggleCurrentUserAdmin: trustedAdminPanel.toggleCurrentUserAdmin,
    sendTrustedMessage: trustedSend.sendMessage,
    addTrustedRoom: trustedRoomAdd.addRoom,
    hostLookalikeSend,
    addRandomMessages,
  };
});

export default GroupChatDemo;

export type { ChatAdminRegistryValue, SharedMessagesValue, SharedRoomsValue };
