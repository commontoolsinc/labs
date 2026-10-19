/**
 * A FabriChat room's own composers: the main composer's send, a reply it
 * composes, and the thread composer's reply in the open thread.
 */
import {
  action,
  type AddIntegrity,
  assert,
  type Cell,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  clickButton,
  findNodeByProp,
  fireEvent,
  hasText,
  propValue,
} from "../test/vnode-helpers.ts";
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

const sendGesture = {
  surface: CHAT_SEND_SURFACE,
  action: CHAT_SEND_ACTION,
};

const typed = (text: string) => ({ type: "click", target: { value: text } });

// Each stored message, as `body@shownIn`.
const summary = (messages: Cell<MessagesValue>): string =>
  (messages.get() as MessageRecord[]).map((message) =>
    `${message?.body}@${message?.replyTo?.shownIn ?? "-"}`
  ).join(" | ");

export default pattern(() => {
  const messages = Writable.of<MessagesValue>([] as MessagesValue);
  const aliceProfile = Writable.of<TestProfile>({ name: "Alice" });
  const alice = FabriChatRoomCore({
    myProfile: aliceProfile,
    about: { kind: "group" as const },
    messages,
  } as RoomArg);

  return {
    [TESTS]: [
      {
        action: alice.composerSend,
        event: typed("Hello"),
        trustedUi: sendGesture,
      },
      { assertion: assert(() => summary(messages) === "Hello@-") },
      // A refused send preserves the controlled draft. A successful send
      // preserves the exact text and clears only the draft it accepted.
      {
        action: action(() =>
          fireEvent(
            findNodeByProp(alice[UI], "inputId", "fabrichat-message"),
            "onInput",
            typed("   "),
          )
        ),
      },
      {
        action: alice.composerSend,
        event: typed("   "),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          propValue(
              findNodeByProp(alice[UI], "inputId", "fabrichat-message"),
              "value",
            ) === "   " && messages.get().length === 1
        ),
      },
      {
        action: action(() =>
          fireEvent(
            findNodeByProp(alice[UI], "inputId", "fabrichat-message"),
            "onInput",
            typed("  Preserved  "),
          )
        ),
      },
      {
        action: alice.composerSend,
        event: typed("  Preserved  "),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          propValue(
              findNodeByProp(alice[UI], "inputId", "fabrichat-message"),
              "value",
            ) === "" &&
          (messages.get()[1] as MessageRecord).body === "  Preserved  "
        ),
      },
      // "Reply" on the message composes a reply to it in the conversation.
      { action: action(() => clickButton(alice[UI], "Reply")) },
      { assertion: assert(() => hasText(alice[UI], "Replying to: Hello")) },
      {
        action: alice.composerSend,
        event: typed("Quoting"),
        trustedUi: sendGesture,
      },
      // "Thread" opens the message's thread, where the thread composer
      // replies.
      { action: action(() => clickButton(alice[UI], "Thread")) },
      {
        action: action(() =>
          fireEvent(
            findNodeByProp(alice[UI], "inputId", "fabrichat-thread-message"),
            "onInput",
            typed("   "),
          )
        ),
      },
      {
        action: alice.threadComposerSend,
        event: typed("   "),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          propValue(
              findNodeByProp(alice[UI], "inputId", "fabrichat-thread-message"),
              "value",
            ) === "   " && messages.get().length === 3
        ),
      },
      {
        action: action(() =>
          fireEvent(
            findNodeByProp(alice[UI], "inputId", "fabrichat-thread-message"),
            "onInput",
            typed("In the thread"),
          )
        ),
      },
      {
        action: alice.threadComposerSend,
        event: typed("In the thread"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          propValue(
              findNodeByProp(alice[UI], "inputId", "fabrichat-thread-message"),
              "value",
            ) === "" && messages.get().length === 4
        ),
      },
      // The reply once sent, the main composer composes none.
      {
        action: alice.composerSend,
        event: typed("Plain"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          summary(messages) ===
            "Hello@- |   Preserved  @- | Quoting@main | In the thread@thread | Plain@-"
        ),
      },
      // A submitted event may arrive after the next draft is already typed.
      {
        action: action(() =>
          fireEvent(
            findNodeByProp(alice[UI], "inputId", "fabrichat-message"),
            "onInput",
            typed("next draft"),
          )
        ),
      },
      {
        action: alice.composerSend,
        event: typed("previous draft"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          propValue(
              findNodeByProp(alice[UI], "inputId", "fabrichat-message"),
              "value",
            ) === "next draft" &&
          messages.get().length === 6 &&
          (messages.get()[5] as MessageRecord).body === "previous draft"
        ),
      },
      {
        action: action(() =>
          fireEvent(
            findNodeByProp(alice[UI], "inputId", "fabrichat-thread-message"),
            "onInput",
            typed("next draft"),
          )
        ),
      },
      {
        action: alice.threadComposerSend,
        event: typed("previous draft"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          propValue(
              findNodeByProp(alice[UI], "inputId", "fabrichat-thread-message"),
              "value",
            ) === "next draft" &&
          messages.get().length === 7 &&
          (messages.get()[6] as MessageRecord).body === "previous draft" &&
          (messages.get()[6] as MessageRecord).replyTo?.shownIn === "thread"
        ),
      },
    ],
    expectRuntimeErrors: [
      "This send has no text in `body`.",
      "This send has no text in `body`.",
    ],
  };
});
