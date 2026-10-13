/**
 * Where a room's rendering shows each message: which rows the main
 * conversation and the open thread show, the reply count a thread's root
 * carries, and which of a row's controls a viewer is offered.
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
  childNodes,
  clickButton,
  clickInRow,
  findNode,
  findNodeById,
  hasText,
  isButton,
  propValue,
  readValue,
  textContent,
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

const MAIN = "fabrichat-messages";
const THREAD = "fabrichat-thread";

/** What `node` has as its display, as its `style` names it. */
const displayOf = (node: unknown) =>
  readValue(
    (propValue(node, "style") as { display?: unknown } | undefined)?.display,
  );

/**
 * The row showing `text` in the list `id` under `root`: the first node inside
 * the list that carries `hidden` and the text.
 */
const rowIn = (root: unknown, id: string, text: string): unknown =>
  childNodes(findNodeById(root, id))
    .map((child) =>
      findNode(
        child,
        (node) => propValue(node, "hidden") === true && hasText(node, text),
      )
    )
    .find((row) => row !== undefined);

/** How each of `texts`' rows in the list `id` is displayed, in their order. */
const rowDisplays = (
  root: unknown,
  id: string,
  texts: readonly string[],
): string =>
  texts.map((text) => {
    const row = rowIn(root, id, text);
    return row === undefined ? "missing" : String(displayOf(row));
  }).join(" ");

/** The link to its thread that the main row showing `text` carries. */
const threadLink = (root: unknown, text: string): unknown =>
  findNode(
    rowIn(root, MAIN, text),
    (node) => propValue(node, "variant") === "link",
  );

/** A thread link's display, and its label where it is shown. */
const threadLinkText = (root: unknown, text: string): string => {
  const link = threadLink(root, text);
  const display = String(displayOf(link));
  return display === "none" ? display : `${display} ${textContent(link)}`;
};

/** The display of the control labelled `label` in the main row `text`. */
const controlDisplay = (root: unknown, text: string, label: string) =>
  displayOf(findNode(rowIn(root, MAIN, text), isButton(label)));

/** Whether the main row `text` has its reaction control disabled. */
const reactDisabled = (root: unknown, text: string) =>
  propValue(
    findNode(
      rowIn(root, MAIN, text),
      (node) => propValue(node, "aria-label") === "Add reaction",
    ),
    "disabled",
  );

const ALL = ["Root", "Other", "First reply", "Second reply"];

export default pattern(() => {
  const messages = Writable.of<MessagesValue>([] as MessagesValue);
  const aliceProfile = Writable.of<TestProfile>({ name: "Alice" });
  const bobProfile = Writable.of<TestProfile>({ name: "Bob" });
  const pendingProfile = Writable.of<TestProfile | undefined>(undefined);
  const records = {
    about: { kind: "group" as const },
    messages,
    reactionLists: Writable.of<ReactionList[]>([] as ReactionList[]),
    requests: Writable.of<RequestMemo[]>([]),
    usedTimes: Writable.of<UsedTime[]>([]),
    activity: Writable.of<SentActivity[]>([]),
    counters: Writable.of<ActivityCounters[]>([]),
  };
  const alice = FabriChatRoomCore(
    { myProfile: aliceProfile, ...records } as RoomArg,
  );
  const bob = FabriChatRoomCore(
    { myProfile: bobProfile, ...records } as RoomArg,
  );
  const pending = FabriChatRoomCore(
    { myProfile: pendingProfile, ...records } as RoomArg,
  );

  return {
    [TESTS]: [
      {
        action: alice.composerSend,
        event: typed("Root"),
        trustedUi: sendGesture,
      },
      {
        action: bob.composerSend,
        event: typed("Other"),
        trustedUi: sendGesture,
      },
      // Both are in the main conversation, and no thread is open.
      {
        assertion: assert(() =>
          rowDisplays(alice[UI], MAIN, ["Root", "Other"]) === "block block"
        ),
      },
      {
        assertion: assert(() =>
          rowDisplays(alice[UI], THREAD, ["Root", "Other"]) === "none none"
        ),
      },
      {
        assertion: assert(() =>
          threadLinkText(alice[UI], "Root") === "none" &&
          threadLinkText(alice[UI], "Other") === "none"
        ),
      },

      // A reply in the open thread stays out of the main conversation, and
      // its root counts it.
      { action: action(() => clickInRow(alice[UI], "Root", "Thread")) },
      {
        assertion: assert(() =>
          rowDisplays(alice[UI], THREAD, ["Root", "Other"]) === "block none"
        ),
      },
      {
        action: alice.threadComposerSend,
        event: typed("First reply"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          rowDisplays(alice[UI], MAIN, ALL.slice(0, 3)) === "block block none"
        ),
      },
      {
        assertion: assert(() =>
          rowDisplays(alice[UI], THREAD, ALL.slice(0, 3)) ===
            "block none block"
        ),
      },
      {
        assertion: assert(() =>
          threadLinkText(alice[UI], "Root") === "inline-flex 1 reply" &&
          threadLinkText(alice[UI], "Other") === "none"
        ),
      },
      {
        action: alice.threadComposerSend,
        event: typed("Second reply"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          rowDisplays(alice[UI], THREAD, ALL) === "block none block block"
        ),
      },
      {
        assertion: assert(() =>
          threadLinkText(alice[UI], "Root") === "inline-flex 2 replies"
        ),
      },

      // The open thread is the session's: another viewer's stays closed, and
      // their main conversation shows the same rows and the same count.
      {
        assertion: assert(() =>
          rowDisplays(bob[UI], THREAD, ALL) === "none none none none"
        ),
      },
      {
        assertion: assert(() =>
          rowDisplays(bob[UI], MAIN, ALL) === "block block none none" &&
          threadLinkText(bob[UI], "Root") === "inline-flex 2 replies"
        ),
      },

      // Opening another message's thread shows that message alone.
      { action: action(() => clickInRow(alice[UI], "Other", "Thread")) },
      {
        assertion: assert(() =>
          rowDisplays(alice[UI], THREAD, ALL) === "none block none none"
        ),
      },
      { action: action(() => clickButton(alice[UI], "Close")) },
      {
        assertion: assert(() =>
          rowDisplays(alice[UI], THREAD, ALL) === "none none none none"
        ),
      },

      // A row offers its edit and delete controls to its sender alone, and
      // its removal to the room's OWNER, which this lane's user is.
      {
        assertion: assert(() =>
          controlDisplay(alice[UI], "Root", "Edit") === "inline-flex" &&
          controlDisplay(alice[UI], "Other", "Edit") === "none" &&
          controlDisplay(bob[UI], "Other", "Edit") === "inline-flex"
        ),
      },
      {
        assertion: assert(() =>
          controlDisplay(alice[UI], "Other", "Remove entirely") ===
            "inline-flex"
        ),
      },
      // A viewer whose profile hasn't resolved can't react, and is offered
      // neither.
      {
        assertion: assert(() =>
          reactDisabled(alice[UI], "Root") === false &&
          reactDisabled(pending[UI], "Root") === true
        ),
      },
      {
        assertion: assert(() =>
          controlDisplay(pending[UI], "Root", "Edit") === "none" &&
          controlDisplay(pending[UI], "Root", "Remove entirely") === "none"
        ),
      },
    ],
  };
});
