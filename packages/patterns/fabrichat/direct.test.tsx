/**
 * Deleting and obliterating in a FabriChat direct room: either of its two
 * people, each an OWNER of its space, may delete and obliterate the other's
 * messages as well as their own. Someone the space admits with WRITE alone,
 * as a direct room whose space has grown may, may obliterate their own
 * messages, as anyone in a direct room may, and nobody else's.
 *
 * The test lane doesn't enforce the access list, so what this checks is what
 * the room decides from the level `spaceAccess()` reports.
 */
import {
  type AddIntegrity,
  assert,
  type Cell,
  equals,
  multiUserTest,
  pattern,
  TESTS,
  VIEWS,
  Writable,
} from "commonfabric";
import { FabriChatMessageRow } from "./message-row.tsx";
import {
  type ActivityCounters,
  type MessageRecord,
  type MessagesValue,
  type ReactionList,
  type RequestMemo,
  type SentActivity,
  type UsedTime,
  viewKeyOf,
} from "./room-records.tsx";
import { FabriChatRoomCore } from "./room.tsx";
import {
  CHAT_DELETE_ACTION,
  CHAT_DELETE_SURFACE,
  CHAT_OBLITERATE_ACTION,
  CHAT_OBLITERATE_SURFACE,
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  type ChatProfile,
} from "./schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];
type RowArg = Parameters<typeof FabriChatMessageRow>[0];

// A labeled stand-in for a viewer's `#profile`.
type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

const sendGesture = { surface: CHAT_SEND_SURFACE, action: CHAT_SEND_ACTION };
const deleteGesture = {
  surface: CHAT_DELETE_SURFACE,
  action: CHAT_DELETE_ACTION,
};
const obliterateGesture = {
  surface: CHAT_OBLITERATE_SURFACE,
  action: CHAT_OBLITERATE_ACTION,
};

const typed = (text: string) => ({ type: "click", target: { value: text } });

/** The room's records, which every participant's room shares. */
interface Records {
  messages: Writable<MessagesValue>;
  reactionLists: Writable<ReactionList[]>;
  requests: Writable<RequestMemo[]>;
  usedTimes: Writable<UsedTime[]>;
  activity: Writable<SentActivity[]>;
  counters: Writable<ActivityCounters[]>;
}

/** What every session receives from the setup. */
interface Setup {
  records: Records;
}

export const setup = pattern(() => ({
  records: {
    messages: Writable.of<MessagesValue>([] as MessagesValue),
    reactionLists: Writable.of<ReactionList[]>([] as ReactionList[]),
    requests: Writable.of<RequestMemo[]>([]),
    usedTimes: Writable.of<UsedTime[]>([]),
    activity: Writable.of<SentActivity[]>([]),
    counters: Writable.of<ActivityCounters[]>([]),
  },
}));

// Each message's body, or how it was taken away, in the order they were
// recorded.
const bodies = (messages: Cell<MessagesValue>): string =>
  ((messages.get() ?? []) as MessageRecord[]).map((message) =>
    typeof message?.body === "string"
      ? message.body
      : message?.authorProfile === undefined
      ? "<obliterated>"
      : "<deleted>"
  ).join(" | ");

// The stored message at `index` of `messages`.
const messageAt = (
  messages: Cell<MessagesValue>,
  index: number,
): MessageRecord | undefined =>
  ((messages.get() ?? []) as MessageRecord[])[index];

/** What makes the shared room a direct room of its own. */
const directRoom = { about: { kind: "direct" as const } };

// The room's creator, an OWNER, who sends first and obliterates Bob's second
// message.
export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<TestProfile>({ name: "Alice" });
  const records = {
    messages: setup.records.messages,
    reactionLists: setup.records.reactionLists,
    requests: setup.records.requests,
    usedTimes: setup.records.usedTimes,
    activity: setup.records.activity,
    counters: setup.records.counters,
  };
  const room = FabriChatRoomCore(
    { myProfile: profile, ...directRoom, ...records } as RoomArg,
  );
  const onBobsSecond = FabriChatMessageRow({
    message: setup.records.messages.key(2),
    myProfile: profile,
    inThread: false,
    kind: "direct" as const,
    composer: Writable.of({}),
    // Stand-ins for what the room derives; a row's streams read none of it.
    places: {},
    cannotWrite: false,
    isOwner: false,
    ...records,
  } as RowArg);

  return {
    [TESTS]: [
      {
        action: room.composerSend,
        event: typed("From Alice"),
        trustedUi: sendGesture,
      },
      { label: "alice-sent" },
      { await: "bob-deleted" },
      {
        action: onBobsSecond.obliterateMessage,
        event: {},
        trustedUi: obliterateGesture,
      },
      {
        assertion: assert(() =>
          bodies(setup.records.messages) ===
            "<deleted> | From Bob | <obliterated> | <obliterated>"
        ),
      },
      // Bob's deletion of her message keeps her as its author.
      {
        assertion: assert(() =>
          equals(messageAt(setup.records.messages, 0)?.authorProfile, profile)
        ),
      },
      { label: "alice-done" },
    ],
  };
});

// The other person, also an OWNER, who deletes Alice's message.
export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<TestProfile>({ name: "Bob" });
  const records = {
    messages: setup.records.messages,
    reactionLists: setup.records.reactionLists,
    requests: setup.records.requests,
    usedTimes: setup.records.usedTimes,
    activity: setup.records.activity,
    counters: setup.records.counters,
  };
  const room = FabriChatRoomCore(
    { myProfile: profile, ...directRoom, ...records } as RoomArg,
  );
  const onAlices = FabriChatMessageRow({
    message: setup.records.messages.key(0),
    myProfile: profile,
    inThread: false,
    kind: "direct" as const,
    composer: Writable.of({}),
    // Stand-ins for what the room derives; a row's streams read none of it.
    places: {},
    cannotWrite: false,
    isOwner: false,
    ...records,
  } as RowArg);

  return {
    [TESTS]: [
      { await: "alice-sent" },
      {
        action: room.composerSend,
        event: typed("From Bob"),
        trustedUi: sendGesture,
      },
      {
        action: room.composerSend,
        event: typed("Bob again"),
        trustedUi: sendGesture,
      },
      { label: "bob-sent" },
      { await: "carol-done" },
      // An OWNER's view offers him deleting and obliterating Alice's message,
      // but not editing it.
      {
        assertion: assert(() => {
          const key = viewKeyOf(setup.records.messages.key(0)) ?? "";
          const hers = room[VIEWS].room.messageRights[key];
          return hers?.canEdit === false && hers?.canDelete === true &&
            hers?.canObliterate === true;
        }),
      },
      {
        action: onAlices.deleteMessage,
        event: {},
        trustedUi: deleteGesture,
      },
      {
        assertion: assert(() =>
          bodies(setup.records.messages) ===
            "<deleted> | From Bob | Bob again | <obliterated>"
        ),
      },
      { label: "bob-deleted" },
      { await: "alice-done" },
    ],
  };
});

// Someone the space admits with WRITE, who may take away only her own
// message.
export const carol = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<TestProfile>({ name: "Carol" });
  const records = {
    messages: setup.records.messages,
    reactionLists: setup.records.reactionLists,
    requests: setup.records.requests,
    usedTimes: setup.records.usedTimes,
    activity: setup.records.activity,
    counters: setup.records.counters,
  };
  const room = FabriChatRoomCore(
    { myProfile: profile, ...directRoom, ...records } as RoomArg,
  );
  const rowRecords = {
    myProfile: profile,
    inThread: false,
    kind: "direct" as const,
    composer: Writable.of({}),
    // Stand-ins for what the room derives; a row's streams read none of it.
    places: {},
    cannotWrite: false,
    isOwner: false,
    ...records,
  };
  const onAlices = FabriChatMessageRow({
    message: setup.records.messages.key(0),
    ...rowRecords,
  } as RowArg);
  const onHers = FabriChatMessageRow({
    message: setup.records.messages.key(3),
    ...rowRecords,
  } as RowArg);

  return {
    [TESTS]: [
      { await: "bob-sent" },
      {
        action: room.composerSend,
        event: typed("From Carol"),
        trustedUi: sendGesture,
      },
      {
        action: onAlices.deleteMessage,
        event: {},
        trustedUi: deleteGesture,
      },
      {
        action: onAlices.obliterateMessage,
        event: {},
        trustedUi: obliterateGesture,
      },
      {
        assertion: assert(() =>
          bodies(setup.records.messages) ===
            "From Alice | From Bob | Bob again | From Carol"
        ),
      },
      {
        assertion: assert(() => {
          const key = viewKeyOf(setup.records.messages.key(0)) ?? "";
          const hers = room[VIEWS].room.messageRights[key];
          return hers?.canEdit === false && hers?.canDelete === false &&
            hers?.canObliterate === false;
        }),
      },
      {
        action: onHers.obliterateMessage,
        event: {},
        trustedUi: obliterateGesture,
      },
      {
        assertion: assert(() =>
          bodies(setup.records.messages) ===
            "From Alice | From Bob | Bob again | <obliterated>"
        ),
      },
      { label: "carol-done" },
      { await: "alice-done" },
    ],
  };
});

export default multiUserTest({
  setup,
  participants: {
    alice,
    bob: { pattern: bob, access: "OWNER" },
    carol,
  },
});
