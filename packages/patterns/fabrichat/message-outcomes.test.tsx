/**
 * What a FabriChat room tells a session of a message act it refused: the
 * reason, in `messageRefusal` and in the composer, until an act takes effect,
 * which clears it. A refused act writes nothing else. A viewer whose profile
 * doesn't resolve, as `#profile` resolves none where Home lists no profile,
 * has each send refused for the want of one.
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
  findNodeById,
  propValue,
  readValue,
  textContent,
} from "../test/vnode-helpers.ts";
import { type MessageRecord, type MessagesValue } from "./room-records.tsx";
import FabriChatRoom, { FabriChatRoomCore } from "./room.tsx";
import {
  CHAT_DELETE_ACTION,
  CHAT_DELETE_SURFACE,
  CHAT_REACT_ACTION,
  CHAT_REACT_SURFACE,
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  type ChatProfile,
  epochNsec,
} from "./schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];
type FullRoomArg = Parameters<typeof FabriChatRoom>[0];

// A labeled stand-in for a viewer's `#profile`.
type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

const sendGesture = { surface: CHAT_SEND_SURFACE, action: CHAT_SEND_ACTION };
const reactGesture = { surface: CHAT_REACT_SURFACE, action: CHAT_REACT_ACTION };
const deleteGesture = {
  surface: CHAT_DELETE_SURFACE,
  action: CHAT_DELETE_ACTION,
};

const NO_PROFILE =
  "Acting in a chat needs a profile, and yours hasn't resolved.";

const typed = (text: string) => ({ type: "click", target: { value: text } });

/** What the room's composer shows of the session's latest refusal. */
const shownRefusal = (root: unknown): string => {
  const node = findNodeById(root, "fabrichat-act-refusal");
  const display = readValue(
    (propValue(node, "style") as { display?: unknown })?.display,
  );
  return display === "none" ? "" : textContent(node).trim();
};

/** A message of a room's records, as an event names it. */
function messageOf(cell: unknown): Writable<MessageRecord>;
function messageOf(cell: unknown): unknown {
  return cell;
}

/** A room's records, with none of them holding anything yet. */
const freshRecords = () => ({
  messages: Writable.of<MessagesValue>([] as MessagesValue),
});

export default pattern(() => {
  const aliceProfile = Writable.of<TestProfile | undefined>({
    name: "Alice",
  });
  const bobProfile = Writable.of<TestProfile>({ name: "Bob" });
  const records = freshRecords();
  const about = { kind: "group" as const, title: "Team" };
  const alice = FabriChatRoomCore(
    { myProfile: aliceProfile, about, ...records } as RoomArg,
  );
  // The same room, to a second viewer under another profile.
  const bob = FabriChatRoomCore(
    { myProfile: bobProfile, about, ...records } as RoomArg,
  );
  // The same room, to a viewer whose profile hasn't resolved.
  const unresolved = FabriChatRoomCore({
    myProfile: Writable.of<TestProfile | undefined>(undefined),
    about,
    ...records,
  } as RoomArg);
  // A room whose viewer's `#profile` resolves none, as where Home's
  // `profiles` is empty: a space's own chat, which needs no `about`.
  const homeless = FabriChatRoom({ ...freshRecords() } as FullRoomArg);

  const action_bob_edits_alices = action(() =>
    bob.editMessage.send({
      message: messageOf(records.messages.key(0)),
      target: { value: "Bob was here" },
    })
  );
  // A message that isn't one of the room's: one made beside the room.
  const action_edit_unsent = action(() =>
    alice.editMessage.send({
      message: Writable.of<MessageRecord>(
        { body: "Not here", sentAt: epochNsec(0n) },
      ),
      target: { value: "Changed" },
    })
  );
  const action_edit_deleted = action(() =>
    alice.editMessage.send({
      message: messageOf(records.messages.key(0)),
      target: { value: "Never mind" },
    })
  );

  return {
    [TESTS]: [
      // A send that takes effect leaves no refusal, and the composer shows
      // nothing.
      {
        action: alice.sendMessage,
        event: typed("Hello"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          alice.messageRefusal === "" &&
          records.messages.get().length === 1 &&
          shownRefusal(alice[UI]) === ""
        ),
      },
      // A message with no text is refused, writes nothing, and the composer
      // says why.
      {
        action: alice.sendMessage,
        event: typed("   "),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          alice.messageRefusal === "A message needs some text." &&
          records.messages.get().length === 1 &&
          shownRefusal(alice[UI]) === "A message needs some text."
        ),
      },
      // An act that takes effect clears what the composer shows.
      {
        action: alice.sendMessage,
        event: typed("Again"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          alice.messageRefusal === "" && shownRefusal(alice[UI]) === ""
        ),
      },
      // Editing someone else's message isn't allowed, and a message that
      // isn't one of the room's names no target.
      { action: action_bob_edits_alices },
      { action: action_edit_unsent },
      {
        assertion: assert(() =>
          bob.messageRefusal === "Only its author can edit a message." &&
          alice.messageRefusal === "That message isn't in this chat." &&
          (records.messages.get() as MessageRecord[])[0]?.body === "Hello"
        ),
      },
      // A reaction that isn't a single emoji is refused.
      {
        action: alice.sendReaction,
        event: { emoji: "cat", message: messageOf(records.messages.key(0)) },
        trustedUi: reactGesture,
      },
      {
        assertion: assert(() =>
          alice.messageRefusal === "A reaction is a single emoji."
        ),
      },
      // Editing a deleted message targets a deleted message.
      {
        action: alice.deleteMessage,
        event: { message: messageOf(records.messages.key(0)) },
        trustedUi: deleteGesture,
      },
      { assertion: assert(() => alice.messageRefusal === "") },
      { action: action_edit_deleted },
      {
        assertion: assert(() =>
          alice.messageRefusal === "That message was deleted."
        ),
      },
      // A viewer whose profile hasn't resolved can't send.
      {
        action: unresolved.sendMessage,
        event: typed("Anyone?"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() => unresolved.messageRefusal === NO_PROFILE),
      },
      // Nor can a viewer whose `#profile` resolves none, as where Home lists
      // no profile: the send says why, rather than vanishing.
      {
        action: homeless.sendMessage,
        event: typed("Is this thing on?"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          homeless.messageRefusal === NO_PROFILE &&
          homeless.messages.count === 0
        ),
      },
    ],
  };
});
