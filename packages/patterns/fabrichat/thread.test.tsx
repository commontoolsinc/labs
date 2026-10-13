/**
 * A FabriChat room's thread panel: its list holds a row for each message of
 * the session's open thread and for no other, while the main conversation's
 * list keeps a row for every message.
 */
import {
  action,
  type AddIntegrity,
  assert,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  clickButton,
  clickInRow,
  countElements,
  findNodeById,
  hasText,
} from "../test/vnode-helpers.ts";
import {
  type ActivityCounters,
  type MessagesValue,
  type ReactionList,
  type RequestMemo,
  type SentActivity,
  type UsedTime,
} from "./room-records.tsx";
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

const sendGesture = {
  surface: CHAT_SEND_SURFACE,
  action: CHAT_SEND_ACTION,
};

const typed = (text: string) => ({ type: "click", target: { value: text } });

// How many message rows the element `id` under `root` holds, shown or hidden:
// each row is one `cf-hover-reveal`.
const rowsIn = (root: unknown, id: string): number =>
  countElements(findNodeById(root, id), "cf-hover-reveal");

// Whether the thread panel under `root` holds `text`.
const threadHas = (root: unknown, text: string): boolean =>
  hasText(findNodeById(root, "fabrichat-thread"), text);

export default pattern(() => {
  const messages = Writable.of<MessagesValue>([] as MessagesValue);
  const aliceProfile = Writable.of<TestProfile>({ name: "Alice" });
  const alice = FabriChatRoomCore({
    myProfile: aliceProfile,
    about: { kind: "group" as const },
    messages,
    reactionLists: Writable.of<ReactionList[]>([] as ReactionList[]),
    requests: Writable.of<RequestMemo[]>([]),
    usedTimes: Writable.of<UsedTime[]>([]),
    activity: Writable.of<SentActivity[]>([]),
    counters: Writable.of<ActivityCounters[]>([]),
  } as RoomArg);

  return {
    [TESTS]: [
      {
        action: alice.composerSend,
        event: typed("Hello"),
        trustedUi: sendGesture,
      },
      {
        action: alice.composerSend,
        event: typed("Other"),
        trustedUi: sendGesture,
      },
      // With no thread open, the thread panel holds no row.
      {
        assertion: assert(() => rowsIn(alice[UI], "fabrichat-messages") === 2),
      },
      { assertion: assert(() => rowsIn(alice[UI], "fabrichat-thread") === 0) },
      // An open thread holds its root's row alone until someone replies.
      { action: action(() => clickInRow(alice[UI], "Hello", "Thread")) },
      { assertion: assert(() => rowsIn(alice[UI], "fabrichat-thread") === 1) },
      { assertion: assert(() => threadHas(alice[UI], "Hello") === true) },
      { assertion: assert(() => threadHas(alice[UI], "Other") === false) },
      {
        action: alice.threadComposerSend,
        event: typed("In the thread"),
        trustedUi: sendGesture,
      },
      { assertion: assert(() => rowsIn(alice[UI], "fabrichat-thread") === 2) },
      {
        assertion: assert(() => threadHas(alice[UI], "In the thread") === true),
      },
      { assertion: assert(() => threadHas(alice[UI], "Other") === false) },
      // The room renders with the thread open, its rows among the rest.
      { render: alice[UI] },
      // The main conversation keeps a row for every message, the reply's
      // among them.
      {
        assertion: assert(() => rowsIn(alice[UI], "fabrichat-messages") === 3),
      },
      // Opening another message's thread replaces the rows.
      { action: action(() => clickInRow(alice[UI], "Other", "Thread")) },
      { assertion: assert(() => rowsIn(alice[UI], "fabrichat-thread") === 1) },
      { assertion: assert(() => threadHas(alice[UI], "Other") === true) },
      { assertion: assert(() => threadHas(alice[UI], "Hello") === false) },
      // Reopening the first thread brings its rows back.
      { action: action(() => clickInRow(alice[UI], "Hello", "Thread")) },
      { assertion: assert(() => rowsIn(alice[UI], "fabrichat-thread") === 2) },
      {
        assertion: assert(() => threadHas(alice[UI], "In the thread") === true),
      },
      // A closed thread leaves the panel with none.
      { action: action(() => clickButton(alice[UI], "Close")) },
      { assertion: assert(() => rowsIn(alice[UI], "fabrichat-thread") === 0) },
    ],
  };
});
