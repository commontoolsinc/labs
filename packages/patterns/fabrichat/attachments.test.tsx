/**
 * A FabriChat message's attachments: files of its space's store, which the
 * message links rather than copies. A send attaches entries of the room's
 * space, up to the room's policy's `maxAttachments`, with or without text; an
 * edit replaces only the text; and a deletion or an obliteration drops them
 * with the text, leaving the entries in their store. A send attaching an entry
 * of another space, a removed entry, or more than the policy allows is
 * refused, each by its reason, and the test requires exactly those refusals.
 * Alice and Bob run here as this lane's one principal, which holds OWNER in
 * every space it creates, so what tells them apart is their profiles alone.
 */
import {
  action,
  type AddIntegrity,
  assert,
  type Cell,
  equals,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import { epochNsecFromMsec, type FileEntry } from "../fabrifile/schemas.tsx";
import { countElements } from "../test/vnode-helpers.ts";
import { type MessageRecord, type MessagesValue } from "./room-records.tsx";
import { FabriChatRoomCore } from "./room.tsx";
import {
  CHAT_DELETE_ACTION,
  CHAT_DELETE_SURFACE,
  CHAT_EDIT_ACTION,
  CHAT_EDIT_SURFACE,
  CHAT_OBLITERATE_ACTION,
  CHAT_OBLITERATE_SURFACE,
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
const editGesture = { surface: CHAT_EDIT_SURFACE, action: CHAT_EDIT_ACTION };
const deleteGesture = {
  surface: CHAT_DELETE_SURFACE,
  action: CHAT_DELETE_ACTION,
};
const obliterateGesture = {
  surface: CHAT_OBLITERATE_SURFACE,
  action: CHAT_OBLITERATE_ACTION,
};

/** An entry for a file named `name`, added by `addedBy`. */
const entryOf = (
  name: string,
  mediaType: string,
  addedBy: Cell<TestProfile>,
): FileEntry => ({
  name,
  mediaType,
  blob: { space: "did:key:z6Mk-fabrichat-attachments", id: `fid1:${name}` },
  size: 1024,
  addedAt: epochNsecFromMsec(0),
  addedBy,
});

/** A file entry held by a piece in a space of its own, outside the room's. */
const Elsewhere = pattern<{ entry: FileEntry }, { entry: FileEntry }>((
  { entry },
) => ({ entry }));

/** The room's messages, in the order they were recorded. */
const all = (messages: Cell<MessagesValue>): MessageRecord[] =>
  (messages.get() ?? []) as MessageRecord[];

/**
 * Whether the message at `index` has a body of `body` and attaches exactly
 * `expected`, in that order; `[]` means it has no `attachments` at all.
 */
const holds = (
  messages: Cell<MessagesValue>,
  index: number,
  body: string,
  expected: Cell<FileEntry>[],
): boolean => {
  const message = all(messages)[index];
  if (message === undefined || message.body !== body) return false;
  const attachments = message.attachments;
  if (expected.length === 0) return attachments === undefined;
  return attachments?.length === expected.length &&
    attachments.every((link, i) => equals(link, expected[i]));
};

/** Whether the message at `index` is deleted and attaches nothing. */
const isDeletedBare = (
  messages: Cell<MessagesValue>,
  index: number,
): boolean => {
  const message = all(messages)[index];
  return message !== undefined && typeof message.body !== "string" &&
    message.attachments === undefined;
};

/** A message, as an event names it. */
function messageOf(cell: unknown): Writable<MessageRecord>;
function messageOf(cell: unknown): unknown {
  return cell;
}

export default pattern(() => {
  const aliceProfile = Writable.of<TestProfile>({ name: "Alice" });
  const bobProfile = Writable.of<TestProfile>({ name: "Bob" });

  // A group room whose OWNERs may obliterate.
  const messages = Writable.of<MessagesValue>([] as MessagesValue);
  const records = {
    about: { kind: "group" as const, title: "Team" },
    ownersMayObliterate: true,
    messages,
  };
  const alice = FabriChatRoomCore(
    { myProfile: aliceProfile, ...records } as RoomArg,
  );
  const bob = FabriChatRoomCore(
    { myProfile: bobProfile, ...records } as RoomArg,
  );

  // The room's space's files, as its store would hold them: a photo, a note,
  // and a file since removed. An entry links its adder's profile, a cell,
  // which only an action can write into it.
  const files = Writable.of<FileEntry[]>([]);
  const seed = action(() => {
    files.push(entryOf("photo.png", "image/png", aliceProfile));
    files.push(entryOf("notes.txt", "text/plain", aliceProfile));
    files.push({
      ...entryOf("gone.txt", "text/plain", aliceProfile),
      removedAt: epochNsecFromMsec(1),
    });
  });
  const photo = files.key(0);
  const notes = files.key(1);
  const gone = files.key(2);

  // A file of another space.
  const elsewhere = Writable.of<{ entry: FileEntry } | undefined>(undefined);
  const placeElsewhere = action(() =>
    elsewhere.set(
      Elsewhere.inSpace()({
        entry: entryOf("away.png", "image/png", aliceProfile),
      }),
    )
  );
  const foreign = elsewhere.key("entry");

  const first = messageOf(messages.key(0));
  const second = messageOf(messages.key(1));

  return {
    [TESTS]: [
      { action: seed },
      { action: placeElsewhere },

      // A message with text and two attachments, and one with an attachment
      // alone.
      {
        action: alice.sendMessage,
        event: {
          type: "click",
          target: { value: "Look" },
          attachments: [photo, notes],
        },
        trustedUi: sendGesture,
      },
      {
        action: alice.sendMessage,
        event: { type: "click", target: { value: "" }, attachments: [photo] },
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          all(messages).length === 2 &&
          holds(messages, 0, "Look", [photo, notes]) &&
          holds(messages, 1, "", [photo])
        ),
      },

      // The room shows each attachment: the photo twice as an image, and
      // every attachment as a link.
      {
        assertion: assert(() =>
          countElements(alice[UI], "cf-image") === 2 &&
          countElements(alice[UI], "cf-blob-link") === 3
        ),
      },

      // Refused: a removed file, a file of another space, eleven files, and
      // a send with neither text nor files.
      {
        action: alice.sendMessage,
        event: {
          type: "click",
          target: { value: "Gone" },
          attachments: [gone],
        },
        trustedUi: sendGesture,
      },
      {
        action: alice.sendMessage,
        event: {
          type: "click",
          target: { value: "Away" },
          attachments: [foreign],
        },
        trustedUi: sendGesture,
      },
      {
        action: alice.sendMessage,
        event: {
          type: "click",
          target: { value: "Eleven" },
          attachments: [
            photo,
            photo,
            photo,
            photo,
            photo,
            photo,
            photo,
            photo,
            photo,
            photo,
            photo,
          ],
        },
        trustedUi: sendGesture,
      },
      {
        action: alice.sendMessage,
        event: { type: "click", target: { value: "   " }, attachments: [] },
        trustedUi: sendGesture,
      },
      { assertion: assert(() => all(messages).length === 2) },

      // Ten files is as many as the policy allows.
      {
        action: alice.sendMessage,
        event: {
          type: "click",
          target: { value: "Ten" },
          attachments: [
            notes,
            notes,
            notes,
            notes,
            notes,
            notes,
            notes,
            notes,
            notes,
            notes,
          ],
        },
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          all(messages).length === 3 &&
          all(messages)[2]?.attachments?.length === 10
        ),
      },

      // An edit replaces the text alone, and of a message with attachments
      // may leave it empty.
      {
        action: alice.editMessage,
        event: { message: first, target: { value: "Look again" } },
        trustedUi: editGesture,
      },
      {
        action: alice.editMessage,
        event: { message: messageOf(messages.key(2)), target: { value: "" } },
        trustedUi: editGesture,
      },
      {
        assertion: assert(() =>
          holds(messages, 0, "Look again", [photo, notes]) &&
          all(messages)[2]?.body === "" &&
          all(messages)[2]?.attachments?.length === 10
        ),
      },

      // A deletion, and Bob's obliteration, drop the attachments with the
      // text, and the files stay in the store.
      {
        action: alice.deleteMessage,
        event: { message: first },
        trustedUi: deleteGesture,
      },
      {
        action: bob.obliterateMessage,
        event: { message: second },
        trustedUi: obliterateGesture,
      },
      {
        assertion: assert(() =>
          isDeletedBare(messages, 0) && isDeletedBare(messages, 1) &&
          files.get().length === 3 &&
          files.get()[0]?.removedAt === undefined
        ),
      },
    ],
    // The reason for each refused send above, in the order they run.
    expectRuntimeErrors: [
      "That file was removed.",
      "That file isn't in this chat's space.",
      "A message can have at most 10 attachments.",
      "This send has no text in `body`, and no attachments.",
    ],
  };
});
