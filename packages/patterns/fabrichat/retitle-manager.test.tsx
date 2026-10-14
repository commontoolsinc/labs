/**
 * A FabriChat manager's list following a retitle of a room it created: the
 * room's entry in `rooms` links the room, so it reads the title a member last
 * set through the link, and the rendered list labels the room with it, for a
 * group room and for a direct room, which the list otherwise labels with whom
 * it is with.
 */
import {
  action,
  type AddIntegrity,
  assert,
  type Cell,
  equals,
  pattern,
  type Stream,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import { type SharedSpaceCatalogStorage } from "../system/shared-space-catalog.ts";
import { findNode, propsOf, readValue } from "../test/vnode-helpers.ts";
import { FabriChatManagerCore } from "./manager.tsx";
import { type SetTitleEvent } from "./room-records.tsx";
import {
  CHAT_RETITLE_ACTION,
  CHAT_RETITLE_SURFACE,
  CHAT_START_ACTION,
  CHAT_START_SURFACE,
  type ChatIndexEntry,
  type ChatManagerNotice,
  type ChatProfile,
  type ChatRequestOutcome,
  type ChatRoomLink,
} from "./schemas.tsx";

type ManagerArg = Parameters<typeof FabriChatManagerCore>[0];

// A stand-in for this user's `#profile`, labeled, as a Fabric profile is,
// because a room's participants link only a document that carries a label.
type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

const startGesture = { surface: CHAT_START_SURFACE, action: CHAT_START_ACTION };
const retitleGesture = {
  surface: CHAT_RETITLE_SURFACE,
  action: CHAT_RETITLE_ACTION,
};

// A stand-in for a principal, a base58btc key as a principal's is.
const BOB = "did:key:z6MkBob";

/** The rooms the manager created, held apart from its list. */
interface HeldRooms {
  group?: Cell<ChatRoomLink>;
  direct?: Cell<ChatRoomLink>;
}

/**
 * A held room's `setTitle`, which a step sends to through the link the room
 * is held by.
 */
function setTitleOf(stream: unknown): Stream<SetTitleEvent>;
function setTitleOf(stream: unknown): unknown {
  return stream;
}

// The cell the first `cf-cell-link` labeled `label` under `root` links: a
// listed room's, labeled as its entry is.
const cellLinked = (root: unknown, label: string): object | undefined =>
  propsOf(
    findNode(
      root,
      (node) =>
        readValue((node as { name?: unknown })?.name) === "cf-cell-link" &&
        readValue(propsOf(node)?.label) === label,
    ),
  )?.$cell as object | undefined;

/** The listed room `held` names, by its entry in `rooms`. */
const listed = (
  rooms: readonly ChatIndexEntry[],
  held: Cell<ChatRoomLink> | undefined,
): ChatIndexEntry | undefined =>
  held === undefined
    ? undefined
    : rooms.find((entry) => equals(entry.room, held));

export default pattern(() => {
  const profile = Writable.of<TestProfile>({ name: "Tester" });
  const requests = Writable.of<Record<string, ChatRequestOutcome>>({});
  const manager = FabriChatManagerCore({
    myProfile: profile,
    sharedSpaceCatalog: Writable.of<SharedSpaceCatalogStorage>({
      entries: {},
      offers: {},
    }),
    direct: Writable.of<Record<string, ChatIndexEntry>>({}),
    requests,
    outgoingNotices: Writable.of<ChatManagerNotice[]>([]),
  } as ManagerArg);
  const held = Writable.of<HeldRooms>({});
  const action_hold_rooms = action(() => {
    held.key("group").set(
      requests.key("g-1").key("entry").key("room").resolveAsCell(),
    );
    held.key("direct").set(
      requests.key("d-1").key("entry").key("room").resolveAsCell(),
    );
  });

  return {
    [TESTS]: [
      {
        action: manager.createGroup,
        event: { requestId: "g-1", title: "Team", members: [] },
        trustedUi: startGesture,
      },
      {
        action: manager.openDirect,
        event: { requestId: "d-1", counterpart: BOB },
        trustedUi: startGesture,
      },
      { action: action_hold_rooms },
      // Before any retitle, the list labels the group room with the title it
      // was created with, and the direct room with whom it is with.
      {
        assertion: assert(() =>
          manager.rooms.length === 2 &&
          listed(manager.rooms, held.key("group").get())?.room.key("about")
              .get()?.title === "Team" &&
          equals(cellLinked(manager[UI], "Team"), held.key("group")) &&
          equals(cellLinked(manager[UI], `With ${BOB}`), held.key("direct"))
        ),
      },
      // A member retitles each room, through the room itself.
      {
        action: setTitleOf(held.key("group").key("setTitle")),
        event: { requestId: "t-group", title: "Weekend plans" },
        trustedUi: retitleGesture,
      },
      {
        action: setTitleOf(held.key("direct").key("setTitle")),
        event: { requestId: "t-direct", title: "Bob and me" },
        trustedUi: retitleGesture,
      },
      // Each room's entry reads the new title through its link, and the list
      // labels each room with it.
      {
        assertion: assert(() =>
          listed(manager.rooms, held.key("group").get())?.room.key("about")
              .get()?.title === "Weekend plans" &&
          listed(manager.rooms, held.key("direct").get())?.room.key("about")
              .get()?.title === "Bob and me" &&
          equals(cellLinked(manager[UI], "Weekend plans"), held.key("group")) &&
          equals(cellLinked(manager[UI], "Bob and me"), held.key("direct")) &&
          cellLinked(manager[UI], "Team") === undefined &&
          cellLinked(manager[UI], `With ${BOB}`) === undefined
        ),
      },
    ],
  };
});
