/**
 * Reading a thread from a FabriChat room's `[VIEWS].room` alone: a window onto
 * the thread, opened and closed through the view's own top-level streams, read
 * from the message list's windows, and refused for a root that isn't one. The
 * top-level streams are the message list's own.
 */
import {
  action,
  type AddIntegrity,
  assert,
  equals,
  pattern,
  TESTS,
  VIEWS,
  Writable,
} from "commonfabric";
import { FabriChatMessageRow } from "./message-row.tsx";
import {
  type ChatMessageWindow,
  type ChatMessageWindows,
  type ComposerState,
  type MessagesValue,
} from "./room-records.tsx";
import { FabriChatRoomCore } from "./room.tsx";
import {
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

const sendGesture = {
  surface: CHAT_SEND_SURFACE,
  action: CHAT_SEND_ACTION,
};

const typed = (text: string) => ({ type: "click", target: { value: text } });

/** The records of one room, shared by everyone in its space. */
const roomRecords = () => ({
  about: { kind: "group" as const },
  messages: Writable.of<MessagesValue>([] as MessagesValue),
});

/** The session's windows, as the room's output offers them. */
const windowsOf = (windows: unknown): ChatMessageWindows => {
  const cell = windows as { get?: () => unknown } | undefined;
  const value = typeof cell?.get === "function" ? cell.get() : windows;
  return (value ?? {}) as ChatMessageWindows;
};

/** A window's bodies, oldest first, with `<` and `>` where there is more. */
const windowText = (window: ChatMessageWindow | undefined): string =>
  window === undefined ? "<closed>" : [
    window.hasOlder ? "<" : "",
    ...window.messages.map((each) => each.get()?.body),
    window.hasNewer ? ">" : "",
  ].filter((part) => part !== "").join(" ");

/** The session's window `thread`, which the test opens onto a thread. */
const threadOf = (windows: unknown): ChatMessageWindow | undefined =>
  windowsOf(windows).thread;

export default pattern(() => {
  const records = roomRecords();
  const { messages } = records;
  const aliceProfile = Writable.of<TestProfile>({ name: "Alice" });
  const alice = FabriChatRoomCore(
    { myProfile: aliceProfile, ...records } as RoomArg,
  );
  const room = alice[VIEWS].room;
  // The first message's row, whose controls reply to it.
  const onRoot = FabriChatMessageRow({
    message: messages.key(0),
    myProfile: aliceProfile,
    inThread: false,
    kind: "group" as const,
    composer: Writable.of<ComposerState>({}),
    // Stand-ins for what the room derives; a row's streams read none of it.
    places: {},
    cannotWrite: false,
    isOwner: false,
    ...records,
  } as RowArg);
  // Another room, whose message roots no thread here.
  const elsewhereRecords = roomRecords();
  const elsewhere = FabriChatRoomCore(
    { myProfile: aliceProfile, ...elsewhereRecords } as RoomArg,
  );
  // Each request below names its root by the message's own cell.
  const action_open_root = action(() =>
    room.openWindow.send({
      requestId: "open-root",
      windowId: "thread",
      root: messages.key(0).resolveAsCell(),
      from: { before: "end" },
      count: 10,
    })
  );
  const action_open_reply = action(() =>
    room.openWindow.send({
      requestId: "open-reply",
      windowId: "thread",
      root: messages.key(3).resolveAsCell(),
      from: { before: "end" },
      count: 10,
    })
  );
  const action_open_elsewhere = action(() =>
    room.openWindow.send({
      requestId: "open-elsewhere",
      windowId: "thread",
      root: elsewhereRecords.messages.key(0).resolveAsCell(),
      from: { before: "end" },
      count: 10,
    })
  );
  const action_page_root = action(() =>
    room.openWindow.send({
      requestId: "page-root",
      windowId: "thread",
      root: messages.key(0).resolveAsCell(),
      from: { after: "start" },
      count: 2,
    })
  );

  return {
    [TESTS]: [
      {
        action: room.sendMessage,
        event: typed("Root"),
        trustedUi: sendGesture,
      },
      {
        action: room.sendMessage,
        event: typed("Other"),
        trustedUi: sendGesture,
      },
      {
        action: onRoot.replyInThread,
        event: typed("First reply"),
        trustedUi: sendGesture,
      },
      {
        action: onRoot.replyInBoth,
        event: typed("Second reply"),
        trustedUi: sendGesture,
      },
      {
        action: elsewhere.sendMessage,
        event: typed("Elsewhere"),
        trustedUi: sendGesture,
      },

      // A window onto the first message's thread, opened through the view's
      // top level, holds the root and its replies, oldest first.
      { action: action_open_root },
      {
        assertion: assert(() =>
          windowText(threadOf(room.messages.windows)) ===
            "Root First reply Second reply" &&
          threadOf(room.messages.windows)?.requestId === "open-root" &&
          equals(threadOf(room.messages.windows)?.root, messages.key(0))
        ),
      },

      // A reply in a thread roots none, and a message of another room is no
      // root here: each request is refused, and the window stays as the last
      // request it took left it.
      { action: action_open_reply },
      { action: action_open_elsewhere },
      {
        assertion: assert(() =>
          threadOf(room.messages.windows)?.requestId === "open-root" &&
          windowText(threadOf(room.messages.windows)) ===
            "Root First reply Second reply"
        ),
      },

      // Paging the thread is opening the same window again.
      { action: action_page_root },
      {
        assertion: assert(() =>
          threadOf(room.messages.windows)?.requestId === "page-root" &&
          windowText(threadOf(room.messages.windows)) === "Root First reply >"
        ),
      },

      // Closing it through the view's top level leaves it closed.
      {
        action: room.closeWindow,
        event: { requestId: "close-root", windowId: "thread" },
      },
      {
        assertion: assert(() =>
          windowText(threadOf(room.messages.windows)) === "<closed>"
        ),
      },

      // The top-level streams and the message list's are the same streams,
      // over the same windows: a window onto the main conversation opened
      // through the list is closed through the top level.
      {
        action: room.messages.openWindow,
        event: {
          requestId: "open-main",
          windowId: "main",
          from: { before: "end" },
          count: 10,
        },
      },
      {
        assertion: assert(() =>
          windowText(windowsOf(room.messages.windows).main) ===
            "Root Other Second reply"
        ),
      },
      {
        action: room.closeWindow,
        event: { requestId: "close-main", windowId: "main" },
      },
      {
        assertion: assert(() =>
          windowText(windowsOf(room.messages.windows).main) === "<closed>"
        ),
      },
    ],
  };
});
