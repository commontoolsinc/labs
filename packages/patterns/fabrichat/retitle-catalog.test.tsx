/**
 * A retitle reaching the catalogs a room is listed in. The member who retitles
 * the room tells their manager, as a write in the room does, and their catalog
 * lists the room under the new title at once. Another member's catalog follows
 * when their manager next hears of the room: here, on their next message. A
 * retitle moves the entry's title and nothing else, so its revision and
 * membership stay as they were.
 */
import {
  action,
  type AddIntegrity,
  assert,
  type Cell,
  computed,
  handler,
  multiUserTest,
  pattern,
  SELF,
  spaceOf,
  type Stream,
  TESTS,
  Writable,
} from "commonfabric";
import type { ParticipantRoster } from "../loom/participants.tsx";
import {
  readSharedSpaceCatalog,
  registerSharedSpaceIn,
  type SharedSpaceCatalogStorage,
} from "../system/shared-space-catalog.ts";
import { FabriChatManagerCore } from "./manager.tsx";
import {
  type ActivityCounters,
  type MessagesValue,
  type ReactionList,
  type RequestMemo,
  type RoomStreamEvent,
  type SentActivity,
  type SetTitleEvent,
  type UsedTime,
} from "./room-records.tsx";
import {
  type ChatRoomOutput,
  FabriChatRoomCore,
  type RoomManager,
} from "./room.tsx";
import {
  CHAT_RETITLE_ACTION,
  CHAT_RETITLE_SURFACE,
  CHAT_ROOM_OFFER_KIND,
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  type ChatIndexEntry,
  type ChatManagerNotice,
  type ChatProfile,
  type ChatRequestOutcome,
  type ChatRoomLink,
  type TitleRecord,
} from "./schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];
type ManagerArg = Parameters<typeof FabriChatManagerCore>[0];

// A stand-in for a person's `#profile`, labeled, as a Fabric profile is,
// because a room's participants link only a document that carries a label.
type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

const sendGesture = { surface: CHAT_SEND_SURFACE, action: CHAT_SEND_ACTION };
const retitleGesture = {
  surface: CHAT_RETITLE_SURFACE,
  action: CHAT_RETITLE_ACTION,
};

const typed = (text: string) => ({ type: "click", target: { value: text } });

/** A room's records, which every viewer's room over them shares. */
interface Setup {
  messages: Writable<MessagesValue>;
  reactionLists: Writable<ReactionList[]>;
  requests: Writable<RequestMemo[]>;
  usedTimes: Writable<UsedTime[]>;
  activity: Writable<SentActivity[]>;
  counters: Writable<ActivityCounters[]>;
  titles: Writable<TitleRecord[]>;

  /** Those who joined the room. */
  roster: Writable<ParticipantRoster>;
}

export const setup = pattern(() => ({
  messages: Writable.of<MessagesValue>([] as MessagesValue),
  reactionLists: Writable.of<ReactionList[]>([] as ReactionList[]),
  requests: Writable.of<RequestMemo[]>([]),
  usedTimes: Writable.of<UsedTime[]>([]),
  activity: Writable.of<SentActivity[]>([]),
  counters: Writable.of<ActivityCounters[]>([]),
  titles: Writable.of<TitleRecord[]>([]),
  roster: Writable.of<ParticipantRoster>({}),
}));

/** What `listRoom` is bound to. */
interface EntryState {
  /** The manager's catalog. */
  catalog: Writable<SharedSpaceCatalogStorage>;

  /** The room. */
  room: Cell<ChatRoomLink>;
}

/** Lists the room in the catalog, under no title, as accepting it can. */
const listRoom = handler<unknown, EntryState>((_event, { catalog, room }) => {
  registerSharedSpaceIn(catalog, {
    space: spaceOf(room) ?? "",
    host: "http://localhost:8000",
    kind: CHAT_ROOM_OFFER_KIND,
  });
});

/** A viewer's own result, as the link a manager names the room by. */
function roomLinkOf(room: unknown): Cell<ChatRoomLink>;
function roomLinkOf(room: unknown): unknown {
  return room;
}

/** What a viewer of the room needs. */
interface ViewerInput {
  setup: Setup;

  /** The viewer's profile. */
  profile: Writable<TestProfile>;
}

/** What a viewer of the room does, and what their manager's catalog holds. */
interface ViewerOutput {
  /** The room's `about`, which the manager reads the room's title from. */
  about: ChatRoomOutput["about"];

  /** The room's `addParticipant`, which the manager joins the viewer through. */
  addParticipant: ChatRoomOutput["addParticipant"];

  /** Sends a message as the viewer. */
  sendMessage: Stream<RoomStreamEvent>;

  /** Retitles the room as the viewer. */
  setTitle: Stream<SetTitleEvent>;

  /** Lists the room in the viewer's catalog. */
  list: Stream<unknown>;

  /** The title the room's entry in the viewer's catalog holds. */
  entryTitle?: string;

  /** The revision of the room's entry in the viewer's catalog. */
  entryRevision?: string;

  /** The state of the room's entry in the viewer's catalog. */
  entryState?: string;
}

/**
 * A viewer of the group room, with a manager of their own, which the room
 * tells of the viewer's writes.
 */
const Viewer = pattern<ViewerInput, ViewerOutput>((input) => {
  const { setup, profile } = input;
  const catalog = Writable.of<SharedSpaceCatalogStorage>({
    entries: {},
    offers: {},
  });
  const manager = FabriChatManagerCore({
    myProfile: profile,
    sharedSpaceCatalog: catalog,
    direct: Writable.of<Record<string, ChatIndexEntry>>({}),
    requests: Writable.of<Record<string, ChatRequestOutcome>>({}),
    outgoingNotices: Writable.of<ChatManagerNotice[]>([]),
  } as ManagerArg);
  const self = roomLinkOf(input[SELF]);
  const room = FabriChatRoomCore({
    myProfile: profile,
    about: { kind: "group" as const, title: "Team" },
    messages: setup.messages,
    reactionLists: setup.reactionLists,
    requests: setup.requests,
    usedTimes: setup.usedTimes,
    activity: setup.activity,
    counters: setup.counters,
    titles: setup.titles,
    roster: setup.roster,
    self,
    manager: {
      offerRoom: manager.offerRoom,
      requests: manager.requests,
      people: manager.people,
      joinRoom: manager.joinRoom,
    } as RoomManager,
  } as RoomArg);
  const entry = computed(() =>
    readSharedSpaceCatalog(catalog).entries[spaceOf(self) ?? ""]
  );

  return {
    about: room.about,
    addParticipant: room.addParticipant,
    sendMessage: room.sendMessage,
    setTitle: room.setTitle,
    list: listRoom({ catalog, room: self }),
    entryTitle: computed(() => entry?.title),
    entryRevision: computed(() => entry?.revision),
    entryState: computed(() => entry?.state),
  };
});

// Retitles the room, and her catalog follows at once.
export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const viewer = Viewer({
    setup,
    profile: Writable.of<TestProfile>({ name: "Alice" }),
  });
  // The entry's revision before the retitle, which the retitle leaves as is.
  const listedRevision = Writable.of<string>("");
  const action_note_revision = action(() =>
    listedRevision.set(viewer.entryRevision ?? "")
  );

  return {
    [TESTS]: [
      { action: viewer.list, event: {} },
      {
        assertion: assert(() =>
          viewer.entryState === "saved" && viewer.entryTitle === undefined
        ),
      },
      { action: action_note_revision },
      {
        action: viewer.setTitle,
        event: { requestId: "t-1", title: "Weekend plans" },
        trustedUi: retitleGesture,
      },
      {
        assertion: assert(() =>
          viewer.about.title === "Weekend plans" &&
          viewer.entryTitle === "Weekend plans" &&
          viewer.entryState === "saved" &&
          listedRevision.get() !== "" &&
          viewer.entryRevision === listedRevision.get()
        ),
      },
      { label: "alice-retitled" },
      { await: "bob-done" },
    ],
  };
});

// Listed the room before the retitle; his catalog follows on his next
// message.
export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const viewer = Viewer({
    setup,
    profile: Writable.of<TestProfile>({ name: "Bob" }),
  });

  return {
    [TESTS]: [
      { action: viewer.list, event: {} },
      { await: "alice-retitled" },
      {
        assertion: assert(() =>
          viewer.about.title === "Weekend plans" &&
          viewer.entryTitle === undefined
        ),
      },
      {
        action: viewer.sendMessage,
        event: typed("Sounds good"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          viewer.entryTitle === "Weekend plans" &&
          viewer.entryState === "saved"
        ),
      },
      { label: "bob-done" },
    ],
  };
});

export default multiUserTest({ setup, participants: { alice, bob } });
