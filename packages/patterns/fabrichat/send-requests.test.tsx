/**
 * A FabriChat room's `sendMessage` and the `requestId` a sender may name. A
 * send naming an id its sender has already sent under adds nothing, and the
 * sender's record keeps naming the message the first one sent. A new id with
 * the same text adds a message, and so does every send that names no id. The
 * record is the sender's own, so another person naming the same id sends a
 * message of their own and suppresses no one's. Two sessions of one person
 * sending under one id at once add one message. Every participant sends
 * through one room, as every session of a room does; the room's profile is
 * one stand-in for all of them, since what keeps the record is the principal
 * sending, not the profile.
 */
import {
  type AddIntegrity,
  assert,
  type Cell,
  equals,
  multiUserTest,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import { type MessageRecord, type MessagesValue } from "./room-records.tsx";
import { FabriChatRoomCore } from "./room.tsx";
import {
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  type ChatProfile,
} from "./schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];

// A labeled stand-in for a viewer's `#profile`.
type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

const sendGesture = { surface: CHAT_SEND_SURFACE, action: CHAT_SEND_ACTION };

const typed = (text: string) => ({ type: "click", target: { value: text } });

/** The room every participant sends through. */
type Room = ReturnType<typeof FabriChatRoomCore>;

/** What every session receives from the setup. */
interface Setup {
  messages: Writable<MessagesValue>;
  room: Room;
}

/** Each of `messages`' bodies, in the order they were recorded. */
const bodies = (messages: Cell<MessagesValue>): string[] =>
  ((messages.get() ?? []) as MessageRecord[]).map((message) =>
    typeof message?.body === "string" ? message.body : ""
  );

/** How many of `messages` have the body `text`. */
const countOf = (messages: Cell<MessagesValue>, text: string): number =>
  bodies(messages).filter((body) => body === text).length;

export const setup = pattern(() => {
  const messages = Writable.of<MessagesValue>([] as MessagesValue);
  const room = FabriChatRoomCore({
    myProfile: Writable.of<TestProfile>({ name: "Member" }),
    about: { kind: "group" as const },
    messages,
  } as RoomArg);
  return { messages, room };
});

export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const room = setup.room;

  return {
    [TESTS]: [
      // A send under a new id adds a message, which the record names.
      {
        action: room.sendMessage,
        event: { requestId: "press-1", body: "yes!" },
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          bodies(setup.messages).join() === "yes!" &&
          equals(room.sendRequests["press-1"]?.message, setup.messages.key(0))
        ),
      },
      // The same send again adds nothing, and the record still names the
      // first one's message.
      {
        action: room.sendMessage,
        event: { requestId: "press-1", body: "yes!" },
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          bodies(setup.messages).join() === "yes!" &&
          equals(room.sendRequests["press-1"]?.message, setup.messages.key(0))
        ),
      },
      // The same text under a new id is a new message, and so is each send
      // naming no id.
      {
        action: room.sendMessage,
        event: { requestId: "press-2", body: "yes!" },
        trustedUi: sendGesture,
      },
      {
        action: room.sendMessage,
        event: typed("yes!"),
        trustedUi: sendGesture,
      },
      {
        action: room.sendMessage,
        event: typed("yes!"),
        trustedUi: sendGesture,
      },
      { assertion: assert(() => countOf(setup.messages, "yes!") === 4) },
      { label: "alice-sent" },
      { await: "bob-sent" },
      // Bob named the id Alice sends under next, and his send suppresses
      // nothing of hers.
      {
        action: room.sendMessage,
        event: { requestId: "bob-picked", body: "Alice, under Bob's id" },
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          countOf(setup.messages, "Alice, under Bob's id") === 1 &&
          countOf(setup.messages, "Bob, under his own id") === 1 &&
          countOf(setup.messages, "Bob, under Alice's id") === 1
        ),
      },
      // Alice and her other session send under one id at once.
      { label: "race" },
      {
        action: room.sendMessage,
        event: { requestId: "race", body: "Once" },
        trustedUi: sendGesture,
      },
      { await: "tab-raced" },
      { assertion: assert(() => countOf(setup.messages, "Once") === 1) },
    ],
  };
});

// Another person, who names an id Alice used, and one she has yet to use.
export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const room = setup.room;

  return {
    [TESTS]: [
      { await: "alice-sent" },
      {
        action: room.sendMessage,
        event: { requestId: "press-1", body: "Bob, under Alice's id" },
        trustedUi: sendGesture,
      },
      {
        action: room.sendMessage,
        event: { requestId: "bob-picked", body: "Bob, under his own id" },
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          countOf(setup.messages, "Bob, under Alice's id") === 1 &&
          countOf(setup.messages, "Bob, under his own id") === 1
        ),
      },
      { label: "bob-sent" },
    ],
  };
});

// Alice's other session, which sends under the id her first one sends under.
export const aliceTab = pattern<{ setup: Setup }>(({ setup }) => {
  const room = setup.room;

  return {
    [TESTS]: [
      { await: "race" },
      {
        action: room.sendMessage,
        event: { requestId: "race", body: "Once" },
        trustedUi: sendGesture,
      },
      { label: "tab-raced" },
    ],
  };
});

export default multiUserTest({
  setup,
  participants: {
    alice,
    bob,
    aliceTab: { pattern: aliceTab, user: "alice" },
  },
});
