/**
 * What a FabriChat room stores, the policy its handlers apply, and those
 * handlers (`docs/specs/fabrichat/FabriChatRoom.md`). The records and their
 * writers are one module because each record's write policy names the
 * handlers that may write it.
 *
 * Every stream that changes the room's record has a handler of its own, as
 * `FabriChatRoom.md` names them. `commitWindow` writes the sending session's
 * windows, and `commitSetTitle` the title a member last set, a record of its
 * own beside the one the room's creator wrote.
 *
 * A message is a record of its own in the room's messages, labeled
 * `authored-by` whoever last wrote it, and admitted only from the reviewed
 * surface of the act that wrote it. Its reactions are a list of their own,
 * which the message links, so reacting never rewrites the message. The
 * reaction handlers add to and remove from that list, and a deletion or an
 * obliteration clears it and drops the link.
 */
import {
  AuthoredByCurrentUser,
  type Cell,
  currentPrincipal,
  type Default,
  entityRefToString,
  equals,
  eventKey,
  type FabricEpochNsec,
  getEntityId,
  handler,
  spaceAccess,
  type Stream,
  type TrustedActionWrite,
  Writable,
  type WriteAuthorizedBy,
  type WritePolicyAnyOf,
} from "commonfabric";
import { isSharedSpaceCatalog } from "../system/shared-space-catalog.ts";
import {
  chooseRecordedTime,
  isInMain,
  isSingleEmoji,
  type ShownIn,
  threadView,
  tickOffsetOf,
  type ViewItem,
  type WindowAnchor,
  windowCount,
  windowSlice,
} from "./logic.ts";
import type { commitStart } from "./manager.tsx";
import {
  type AboutRecord,
  CHAT_DELETE_ACTION,
  CHAT_DELETE_SURFACE,
  CHAT_EDIT_ACTION,
  CHAT_EDIT_SURFACE,
  CHAT_OBLITERATE_ACTION,
  CHAT_OBLITERATE_SURFACE,
  CHAT_REACT_ACTION,
  CHAT_REACT_SURFACE,
  CHAT_RETITLE_ACTION,
  CHAT_RETITLE_SURFACE,
  CHAT_ROOM_OFFER_KIND,
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  CHAT_START_ACTION,
  CHAT_START_SURFACE,
  CHAT_UNREACT_ACTION,
  type ChatContainer,
  type ChatDeletedBody,
  type ChatMessageVersion,
  type ChatReaction,
  type ChatRoomActivity,
  type ChatRoomActivityRecord,
  type ChatRoomKind,
  type ChatRoomLink,
  type ChatRoomPolicy,
  CLOCK_TICK_NSEC,
  durationNsec,
  epochNsec,
  epochNsecFromMsec,
  type MessageActOutcome,
  type MessageActRefusalCode,
  nsecOf,
  type ProfileCell,
  type SetTitleOutcome,
  type SetTitleRefusalCode,
  type TitleRecord,
  type WindowEvent,
} from "./schemas.tsx";

//
// Policy
//

/** Nanoseconds in one second. */
const NSEC_PER_SEC = 1_000_000_000n;

/**
 * The policy every room starts from, a group room's. Each setting is read by
 * the handlers it governs, and `about.policy` states it, so the two cannot
 * disagree. A room's `ownersMayObliterate` is `ownersMayObliterateIn()`'s,
 * and the message acts read it from the room's stated policy.
 */
export const FABRICHAT_POLICY: ChatRoomPolicy = {
  ownersMayObliterate: true,
  keepsHistory: true,
  deletionIsObliteration: false,
  proposedTimeMaxAgeNsec: durationNsec(600n * NSEC_PER_SEC),
  proposedTimeMaxLeadNsec: durationNsec(10n * NSEC_PER_SEC),
  recentActivityWindowNsec: durationNsec(600n * NSEC_PER_SEC),
  maxWindowCount: 100,
  maxOpenWindows: 50,
};

/**
 * The `ownersMayObliterate` a room of `kind` states in its policy, which
 * decides which policy document `about.policy` links: `given`, where the room
 * is configured, and otherwise yes for a group room and no for a direct room.
 * What the room enforces is what that document states
 * (`ownersMayObliterateBy()`).
 */
export const ownersMayObliterateIn = (
  kind: ChatRoomKind,
  given?: boolean,
): boolean => given ?? kind !== "direct";

/**
 * How long the room remembers a request it acted on: the greater of the
 * proposed-time window's total width and the activity window.
 */
const REQUEST_MEMORY_NSEC = [
  FABRICHAT_POLICY.proposedTimeMaxAgeNsec.value +
  FABRICHAT_POLICY.proposedTimeMaxLeadNsec.value,
  FABRICHAT_POLICY.recentActivityWindowNsec.value,
].reduce((a, b) => (a > b ? a : b));

/** The time bounds `chooseRecordedTime()` holds a proposal to. */
const TIME_BOUNDS = {
  maxAgeNsec: FABRICHAT_POLICY.proposedTimeMaxAgeNsec.value,
  maxLeadNsec: FABRICHAT_POLICY.proposedTimeMaxLeadNsec.value,
  tickNsec: CLOCK_TICK_NSEC,
};

//
// Stored records
//

/**
 * A stored reaction: written by the reaction handlers, each from the reviewed
 * reaction surface with its own action, and labeled with its reactor; and
 * cleared by a deletion or an obliteration, from that act's own surface.
 */
export type SentReaction = AuthoredByCurrentUser<
  WritePolicyAnyOf<ChatReaction, [
    TrustedActionWrite<
      unknown,
      typeof commitSendReaction,
      typeof CHAT_REACT_ACTION,
      typeof CHAT_REACT_SURFACE
    >,
    TrustedActionWrite<
      unknown,
      typeof commitDeleteReaction,
      typeof CHAT_UNREACT_ACTION,
      typeof CHAT_REACT_SURFACE
    >,
    TrustedActionWrite<
      unknown,
      typeof commitDelete,
      typeof CHAT_DELETE_ACTION,
      typeof CHAT_DELETE_SURFACE
    >,
    TrustedActionWrite<
      unknown,
      typeof commitObliterate,
      typeof CHAT_OBLITERATE_ACTION,
      typeof CHAT_OBLITERATE_SURFACE
    >,
  ]>
>;

/** One message's reactions, in no particular order. */
export type ReactionList = SentReaction[] | Default<[]>;

/** Every message's reaction list, each addressed by its message's key. */
export type ReactionListsCell = Writable<ReactionList[] | Default<[]>>;

/** A stored reply: which message, and where the reply is shown. */
export interface StoredReply {
  /** The message replied to, in the same room. */
  message: Cell<MessageRecord>;

  /** Where the reply is shown. */
  shownIn: ShownIn;
}

/**
 * What the room stores for a message: a `ChatMessage` whose reactions are a
 * link to a list of their own, absent once the message is deleted.
 */
export interface MessageRecord {
  /** The profile the sender sent under; absent once obliterated. */
  authorProfile?: ProfileCell;

  /** The current text, or the marker of a deleted message. */
  body: string | ChatDeletedBody;

  /** When the room recorded the message's first version. */
  sentAt: FabricEpochNsec;

  /** When the room recorded the current version, if it isn't the first. */
  editedAt?: FabricEpochNsec;

  /** The versions before the current one, oldest first. */
  earlierVersions: ChatMessageVersion[];

  /** What this message replies to, and where it is shown. */
  replyTo?: StoredReply;

  /** The message's reactions; absent once the message is deleted. */
  reactions?: Writable<ReactionList>;
}

/**
 * A stored message: written only by the four message handlers, each from its
 * own reviewed surface, and labeled with whoever wrote its current version.
 */
export type SentMessage = AuthoredByCurrentUser<
  WritePolicyAnyOf<MessageRecord, [
    TrustedActionWrite<
      unknown,
      typeof commitSend,
      typeof CHAT_SEND_ACTION,
      typeof CHAT_SEND_SURFACE
    >,
    TrustedActionWrite<
      unknown,
      typeof commitEdit,
      typeof CHAT_EDIT_ACTION,
      typeof CHAT_EDIT_SURFACE
    >,
    TrustedActionWrite<
      unknown,
      typeof commitDelete,
      typeof CHAT_DELETE_ACTION,
      typeof CHAT_DELETE_SURFACE
    >,
    TrustedActionWrite<
      unknown,
      typeof commitObliterate,
      typeof CHAT_OBLITERATE_ACTION,
      typeof CHAT_OBLITERATE_SURFACE
    >,
  ]>
>;

/** The room's messages, in the order they were recorded. */
export type MessagesValue = SentMessage[] | Default<[]>;

/** The cell holding the room's messages. */
export type MessagesCell = Writable<MessagesValue>;

/** A link to one stored message. */
export type MessageCell = Cell<MessageRecord>;

/** A request the room has acted on, remembered until it expires. */
export interface RequestMemo {
  /** The request's key: its sender and its `requestId`. */
  key: string;

  /** When the room acted on it. */
  at: FabricEpochNsec;
}

/**
 * A remembered request, written by whichever handler acted on it. The tuple
 * is written out here, as `WritePolicyAnyOf` requires.
 */
export type StoredRequestMemo = WritePolicyAnyOf<RequestMemo, [
  WriteAuthorizedBy<unknown, typeof commitSend>,
  WriteAuthorizedBy<unknown, typeof commitEdit>,
  WriteAuthorizedBy<unknown, typeof commitDelete>,
  WriteAuthorizedBy<unknown, typeof commitObliterate>,
  WriteAuthorizedBy<unknown, typeof commitSendReaction>,
  WriteAuthorizedBy<unknown, typeof commitDeleteReaction>,
]>;

/** The requests the room has acted on, each addressed by its key. */
export type RequestsCell = Writable<StoredRequestMemo[] | Default<[]>>;

/** A time the room has recorded something at. */
export interface UsedTime {
  /** The time. */
  at: FabricEpochNsec;
}

/** A used time, written by whichever handler recorded something at it. */
export type StoredUsedTime = WritePolicyAnyOf<UsedTime, [
  WriteAuthorizedBy<unknown, typeof commitSend>,
  WriteAuthorizedBy<unknown, typeof commitEdit>,
  WriteAuthorizedBy<unknown, typeof commitDelete>,
  WriteAuthorizedBy<unknown, typeof commitObliterate>,
  WriteAuthorizedBy<unknown, typeof commitSendReaction>,
  WriteAuthorizedBy<unknown, typeof commitDeleteReaction>,
]>;

/** The times the room has used, each addressed by its nanoseconds. */
export type UsedTimesCell = Writable<StoredUsedTime[] | Default<[]>>;

/**
 * What the room stores for an activity entry. An entry stored without a `seq`
 * takes one from its place in the list (`numberActivity()`), and a cleared
 * entry keeps the `seq` it was stored with, so the entries after it keep
 * theirs.
 */
export type ActivityRecord = ChatRoomActivityRecord;

/** Whether the stored entry `entry` was cleared. */
const isCleared = (entry: ActivityRecord | undefined): boolean =>
  entry?.what === undefined || entry.at === undefined;

/** What a cleared entry stores in place of `entry`. */
const clearedFrom = (entry: ActivityRecord): ActivityRecord =>
  entry.seq === undefined ? {} : { seq: entry.seq };

/**
 * A stored activity entry: a document of its own, written once by the handler
 * whose act it records, and labeled `authored-by` the principal that handler
 * acts for. Its writers name no gesture, since entries record acts from every
 * surface; the label says whose act it was, not that they made a gesture. An
 * obliteration clears the message's earlier entries, and `forgetExpired()` the
 * entries it drops for age.
 */
export type SentActivity = AuthoredByCurrentUser<
  WritePolicyAnyOf<ActivityRecord, [
    WriteAuthorizedBy<unknown, typeof commitSend>,
    WriteAuthorizedBy<unknown, typeof commitEdit>,
    WriteAuthorizedBy<unknown, typeof commitDelete>,
    WriteAuthorizedBy<unknown, typeof commitObliterate>,
    WriteAuthorizedBy<unknown, typeof commitSendReaction>,
    WriteAuthorizedBy<unknown, typeof commitDeleteReaction>,
  ]>
>;

/**
 * The room's recent activity, in `seq` order: the order the room's store
 * appended the entries in. An entry cleared by an obliteration or for age
 * keeps its place until `forgetExpired()` drops the run of them at the front,
 * so no entry's place moves while it is in the list.
 */
export type ActivityCell = Writable<SentActivity[] | Default<[]>>;

/** Where the room's activity numbering stands. */
export interface ActivityCounters {
  /**
   * The `seq` the first entry in the activity takes unless it was stored with
   * one: one more than the last entry dropped from the front, and so the
   * `seq` the next entry takes while the activity is empty.
   */
  nextSeq: number;

  /** The highest `seq` dropped for age; 0 for none. */
  expiredThrough: number;
}

/** The empty activity numbering. */
export const NO_ACTIVITY = {
  nextSeq: 1,
  expiredThrough: 0,
} satisfies ActivityCounters;

/**
 * The activity numbering, written as entries are dropped from the front of
 * the activity (`forgetExpired()`), by the act handler bound to drop them: an
 * act appends its entry without reading or writing it.
 */
export type StoredActivityCounters = WritePolicyAnyOf<ActivityCounters, [
  WriteAuthorizedBy<unknown, typeof commitSend>,
  WriteAuthorizedBy<unknown, typeof commitEdit>,
  WriteAuthorizedBy<unknown, typeof commitDelete>,
  WriteAuthorizedBy<unknown, typeof commitObliterate>,
  WriteAuthorizedBy<unknown, typeof commitSendReaction>,
  WriteAuthorizedBy<unknown, typeof commitDeleteReaction>,
]>;

/**
 * The room's activity numbering, kept as one keyed record, `NUMBERING_KEY`,
 * absent until the first entry is dropped. The list around it defaults to
 * empty, so nothing but the handlers its policy lists ever writes the record.
 */
export type ActivityCountersCell = Writable<
  StoredActivityCounters[] | Default<[]>
>;

/** The key of the activity numbering's one record. */
export const NUMBERING_KEY = "numbering";

/** A run of consecutive messages from one view of a conversation. */
export interface ChatMessageWindow {
  /** The `openWindow` request that set the window as it is now. */
  requestId: string;

  /** For a thread's window, the thread's root; absent for the main one. */
  root?: MessageCell;

  /** The messages in the window, oldest first. */
  messages: MessageCell[];

  /** Whether the view has messages older than the window's first. */
  hasOlder: boolean;

  /** Whether the view has messages newer than the window's last. */
  hasNewer: boolean;
}

/** A session's open windows, by the `windowId` its client chose. */
export type ChatMessageWindows = Record<string, ChatMessageWindow>;

/** A session's windows onto the messages, written only by `commitWindow`. */
export type WindowsValue = WriteAuthorizedBy<
  ChatMessageWindows,
  typeof commitWindow
>;

/**
 * The cell holding a session's windows, absent until the first opens: only
 * `commitWindow` writes it, so it has no default for anything else to write.
 */
export type WindowsCell = Writable<WindowsValue>;

/**
 * What a room created by a manager says about itself: written once, by the
 * manager's `commitStart` as it creates the room, from a reviewed `ChatStart`
 * on `ChatStartSurface`, and labeled `authored-by` the room's creator, which
 * `principalOf(about, "authored-by")` reads. It has no default, which
 * something other than its writer would write.
 */
export type StoredAbout = AuthoredByCurrentUser<
  TrustedActionWrite<
    AboutRecord,
    typeof commitStart,
    typeof CHAT_START_ACTION,
    typeof CHAT_START_SURFACE
  >
>;

/**
 * A room's title as a member last set it: written only by `commitSetTitle`,
 * from a reviewed `ChatRetitle` on `ChatRetitleSurface`, and labeled
 * `authored-by` that member. The creator's `about` record keeps the title the
 * room was created with, and its own label.
 */
export type StoredTitle = AuthoredByCurrentUser<
  TrustedActionWrite<
    TitleRecord,
    typeof commitSetTitle,
    typeof CHAT_RETITLE_ACTION,
    typeof CHAT_RETITLE_SURFACE
  >
>;

/**
 * The room's title as a member last set it, kept as one keyed record,
 * `TITLE_KEY`, absent until a member sets one. The list around it defaults to
 * empty, so nothing but `commitSetTitle` ever writes the record.
 */
export type TitlesCell = Writable<StoredTitle[] | Default<[]>>;

/** The key of the one record of the title a member set. */
export const TITLE_KEY = "title";

/**
 * The outcome of each of a sender's retitles, by its `requestId`: one
 * instance per user, which no one else reads.
 */
export type TitleRequestsCell = Writable<
  Record<string, SetTitleOutcome> | Default<Record<PropertyKey, never>>
>;

//
// Helpers
//

/** The entity a cell names, as a string, or `undefined` if it names none. */
export const entityKeyOf = (cell: unknown): string | undefined => {
  const ref = getEntityId(cell);
  return ref === undefined ? undefined : entityRefToString(ref);
};

/** The handler clock's reading, in nanoseconds. */
const clockNsec = (): bigint => nsecOf(epochNsecFromMsec(Date.now()));

/** A request's key: its sender's principal, and its id. */
const requestKeyOf = (sender: string, requestId: string): string =>
  JSON.stringify([sender, requestId]);

/** Whether the room has acted on the request `key` and still remembers it. */
const actedOn = (requests: RequestsCell, key: string): boolean =>
  requests.elementById(key).get() !== undefined;

/**
 * Removes every record recorded before `horizon` from `list`, a list of keyed
 * records, and clears each one: a keyed record outlives its place in the list,
 * and it is the record a lookup by key finds.
 */
const forgetBefore = <T extends { at: FabricEpochNsec }>(
  list: Writable<T[]>,
  keyOf: (record: T) => string,
  horizon: bigint,
): void => {
  ((list.get() ?? []) as T[])
    .filter((record) => record !== undefined && nsecOf(record.at) < horizon)
    .forEach((record) => {
      const key = keyOf(record);
      list.removeByValue(list.elementById(key));
      const cleared: Writable<T | undefined> = list.elementById(key);
      cleared.set(undefined);
    });
};

/**
 * Records that the room acted on the request `key`. It reads nothing of the
 * other requests, so two acts at once don't collide over the memory;
 * `forgetExpired()` forgets the requests older than the room's request memory.
 */
const rememberRequest = (
  requests: RequestsCell,
  key: string,
  clock: bigint,
): void => {
  const memo = requests.elementById(key);
  memo.set({ key, at: epochNsec(clock) });
  requests.addUnique(memo);
};

/**
 * Chooses a recorded time as `chooseRecordedTime()` does, against the times
 * the room has used, and marks it used. `undefined` means the record is
 * refused. It reads only the used times it considers, each by its key, and a
 * time taken from the clock starts at the sender's `offset` into the tick, so
 * two senders' acts in one tick don't consider the same times.
 */
const claimTime = (
  usedTimes: UsedTimesCell,
  clock: bigint,
  offset: bigint,
  proposed?: bigint,
  after?: bigint,
): FabricEpochNsec | undefined => {
  const time = chooseRecordedTime(
    {
      proposed,
      clock,
      after,
      offset,
      isUsed: (t) => usedTimes.elementById(String(t)).get() !== undefined,
    },
    TIME_BOUNDS,
  );
  if (time === undefined) return undefined;
  const at = epochNsec(time);
  const used = usedTimes.elementById(String(time));
  used.set({ at } as StoredUsedTime);
  usedTimes.addUnique(used);
  return at;
};

/**
 * Appends an activity entry recorded at `at`. The entry is a document of its
 * own, keyed by its `at`, which is unique in the room, and it joins the list
 * by a mergeable addition, so appending one reads nothing another act writes:
 * its `seq` is its place in the order the store appends entries in
 * (`numberActivity()`). The act claims `at` before it writes anything, so an
 * act with no time left for its entry is refused rather than recorded without
 * one.
 *
 * `dropFor` first clears every earlier entry about that message, which an
 * obliteration does. A cleared entry keeps its place, so no later entry's
 * `seq` moves, and `numberActivity()` leaves it out.
 */
const appendActivity = (
  activity: ActivityCell,
  at: FabricEpochNsec,
  requestId: string,
  what: Cell<unknown>,
  dropFor?: MessageCell,
): void => {
  if (dropFor !== undefined) {
    ((activity.get() ?? []) as ActivityRecord[]).forEach((entry, index) => {
      if (isCleared(entry) || !equals(entry.what, dropFor)) return;
      const cleared: Writable<SentActivity> = activity.key(index)
        .resolveAsCell();
      cleared.set(clearedFrom(entry) as SentActivity);
    });
  }
  const entry = activity.elementById(`t${nsecOf(at)}`);
  entry.set({ at, requestId, what } as SentActivity);
  activity.addUnique(entry);
};

/** An activity entry, with the `seq` its place in the list gives it. */
export interface NumberedActivity {
  /** The entry's `seq`. */
  seq: number;

  /** The stored entry. */
  entry: ActivityRecord;
}

/**
 * Numbers the stored activity `entries` as `ChatRoomActivity.seq` numbers
 * them. An entry stored with a `seq` keeps it, and every other entry takes one
 * more than the entry before it; the first takes `numbering.nextSeq`. The
 * store appends entries in the order their acts commit, and an entry keeps its
 * place until `forgetExpired()` drops it from the front, which advances
 * `nextSeq` past it, so no entry's `seq` changes while it is in the list.
 */
export const numberActivity = (
  entries: readonly ActivityRecord[],
  numbering: ActivityCounters,
): NumberedActivity[] => {
  let previous = numbering.nextSeq - 1;
  return entries.map((entry) => {
    const seq = entry.seq ?? previous + 1;
    previous = seq;
    return { seq, entry };
  });
};

/** The activity numbering a room's `counters` holds. */
export const numberingOf = (
  counters: Cell<StoredActivityCounters[]>,
): ActivityCounters =>
  (counters.elementById(NUMBERING_KEY).get() ??
    NO_ACTIVITY) as ActivityCounters;

/**
 * The room's recent activity as `ChatRoomOutput.recentActivity` offers it:
 * every entry still standing, numbered, in `seq` order. It reads the list
 * and writes nothing, so its parameters are `Cell`s for the reason
 * `messageEntries()` gives.
 */
export const recentActivityOf = (
  activity: Cell<SentActivity[]>,
  counters: Cell<StoredActivityCounters[]>,
): ChatRoomActivity[] =>
  numberActivity(
    (activity.get() ?? []) as ActivityRecord[],
    numberingOf(counters),
  ).flatMap(({ seq, entry }, index) => {
    if (
      entry.at === undefined || entry.requestId === undefined ||
      entry.what === undefined
    ) {
      return [];
    }
    const record: Cell<ChatRoomActivityRecord> = activity.key(index)
      .resolveAsCell();
    return [{
      seq,
      at: entry.at,
      requestId: entry.requestId,
      what: entry.what,
      record,
    }];
  });

/** A stored message as the views see it, keyed by its `sentAt`. */
export interface MessageEntry extends ViewItem {
  /** A link to the stored message. */
  cell: MessageCell;

  /** The stored message. */
  record: MessageRecord;
}

/**
 * The key a message has in the views: its `sentAt`, unique in the room. It
 * starts with a letter, so that a record keyed by it has no key that reads as
 * an array index.
 */
const timeKeyOf = (time: FabricEpochNsec): string => `t${nsecOf(time)}`;

/**
 * The key the stored message `message` links has in the views, or `undefined`
 * while it links none. It reads the message's `sentAt` and nothing else of
 * it.
 */
export const viewKeyOf = (message: MessageCell): string | undefined => {
  const sentAt = message.key("sentAt").get();
  return sentAt === undefined ? undefined : timeKeyOf(sentAt);
};

/** A link to the stored message at `index` of `messages`. */
const cellAt = (
  messages: Cell<MessagesValue>,
  index: number,
): MessageCell => {
  const cell: MessageCell = messages.key(index);
  return cell;
};

/**
 * Every stored message of `messages`, as a view item. It reads the list and
 * writes nothing, which its parameter declares by being a `Cell` where
 * `MessagesCell` is a `Writable`: a computation that hands a cell to a
 * helper of another module is scheduled as a writer of that cell when the
 * helper's parameter is a `Writable`.
 */
export const messageEntries = (
  messages: Cell<MessagesValue>,
): MessageEntry[] =>
  ((messages.get() ?? []) as MessageRecord[]).flatMap((record, index) => {
    if (record?.sentAt === undefined) return [];
    const target = record.replyTo?.message?.get();
    return [{
      key: timeKeyOf(record.sentAt),
      sentAt: nsecOf(record.sentAt),
      ...(record.replyTo === undefined || target?.sentAt === undefined ? {} : {
        replyTo: {
          key: timeKeyOf(target.sentAt),
          shownIn: record.replyTo.shownIn,
        },
      }),
      cell: cellAt(messages, index),
      record,
    }];
  });

/** The entry for the stored message `message` links, if it is in the room. */
export const entryFor = (
  entries: readonly MessageEntry[],
  message: MessageCell | undefined,
): MessageEntry | undefined => {
  const target = message?.get();
  if (target?.sentAt === undefined) return undefined;
  const key = timeKeyOf(target.sentAt);
  return entries.find((entry) =>
    entry.key === key && equals(entry.cell, message)
  );
};

/** Oldest first, by `sentAt`. */
export const compareEntries = (a: ViewItem, b: ViewItem): number =>
  a.sentAt < b.sentAt ? -1 : a.sentAt > b.sentAt ? 1 : 0;

/** Whether a message is deleted, by its sender or by obliteration. */
export const isDeleted = (record: MessageRecord | undefined): boolean =>
  record === undefined || typeof record.body !== "string";

/** Whether `text` is a message body the room accepts. */
const isValidBody = (text: unknown): text is string =>
  typeof text === "string" && text.trim() !== "";

/** The reply-shown-in values the room accepts. */
const SHOWN_IN: readonly ShownIn[] = ["main", "thread", "both"];

/**
 * Whether the principal this code runs for holds OWNER in the room's space,
 * which `cell` lives in: the event's actor in a handler, the viewer in a
 * computation (see `spaceAccess()`).
 */
export const isOwnerOf = (cell: Cell<unknown>): boolean =>
  spaceAccess(cell) === "OWNER";

/** What one person may do to one message. */
export interface MessageRights {
  /** Whether they may record a new version of it. */
  canEdit: boolean;

  /** Whether they may delete it. */
  canDelete: boolean;

  /** Whether they may obliterate it. */
  canObliterate: boolean;
}

/** The rights of someone who may do nothing to a message. */
export const NO_MESSAGE_RIGHTS: MessageRights = {
  canEdit: false,
  canDelete: false,
  canObliterate: false,
};

/**
 * What the person acting under `profile` may do to the message `record` in a
 * room of `kind`, given whether they hold OWNER in the room's space and
 * whether the room lets its OWNERs obliterate. Only the message's author may
 * edit or delete it, and in a direct room they may obliterate it too. An OWNER
 * may obliterate any message while `ownersMayObliterate` holds, and otherwise
 * gains nothing over anyone else: never an edit or a deletion of someone
 * else's message. A deleted message takes nothing further but obliteration,
 * and an obliterated one, which names no author, takes nothing. The room's
 * handlers admit an act by this, and the room's view and rendering offer one
 * by it.
 */
export const messageRightsOf = (
  record: MessageRecord | undefined,
  profile: ProfileCell | undefined,
  kind: ChatRoomKind,
  isOwner: boolean,
  ownersMayObliterate: boolean,
): MessageRights => {
  const author = record?.authorProfile;
  const isAuthor = author !== undefined && profile !== undefined &&
    equals(author, profile);
  const live = !isDeleted(record);
  return {
    canEdit: live && isAuthor,
    canDelete: live && isAuthor,
    canObliterate: author !== undefined &&
      ((isOwner && ownersMayObliterate) || (kind === "direct" && isAuthor)),
  };
};

/**
 * Whether the room whose policy `policy` is lets its OWNERs obliterate, as
 * the policy states it; a policy that is absent, or doesn't read yet, doesn't.
 */
export const ownersMayObliterateBy = (
  policy: Cell<ChatRoomPolicy> | undefined,
): boolean => policy?.get()?.ownersMayObliterate === true;

/**
 * Why an obliteration `messageRightsOf()` doesn't allow is refused, for a
 * person to read.
 */
const obliterationRefusal = (
  kind: ChatRoomKind,
  ownersMayObliterate: boolean,
): string =>
  kind === "direct"
    ? ownersMayObliterate
      ? "Only an owner of this chat can remove someone else's message."
      : "Only its author can remove a message in this chat."
    : ownersMayObliterate
    ? "Only an owner of this chat can remove a message."
    : "Messages in this chat can't be removed.";

/**
 * Whether the viewer can send, edit, delete, and react in the room whose
 * messages are `messages`: their profile resolves, and the room's space grants
 * them WRITE or OWNER. A level not known yet (`undefined`) is not a grant.
 * `messages` only names the room's space, and is a `Cell` for the reason
 * `messageEntries()` gives.
 */
export const canActIn = (
  messages: Cell<unknown>,
  myProfile: ProfileCell | undefined,
): boolean => {
  const level = spaceAccess(messages);
  return myProfile?.get() !== undefined &&
    (level === "WRITE" || level === "OWNER");
};

/** A `ChatWindowAnchor` as `windowSlice()` takes it, if it is well formed. */
const anchorOf = (
  from: WindowEvent["from"] | undefined,
): WindowAnchor | undefined => {
  if (from === undefined || from === null) return undefined;
  if ("before" in from) {
    return { before: from.before === "end" ? "end" : nsecOf(from.before) };
  }
  if ("after" in from) {
    return { after: from.after === "start" ? "start" : nsecOf(from.after) };
  }
  if ("around" in from) return { around: nsecOf(from.around) };
  return undefined;
};

//
// Writers
//

/**
 * An event on one of the room's streams. Each stream's event carries the
 * fields its act needs. A rendered control sends the text it holds as
 * `target.value`, and no request id, which the room then mints.
 */
export interface RoomStreamEvent {
  /** Chosen by the sender, and unique among its requests. */
  requestId?: string;

  /** The version to send or record. */
  version?: ChatMessageVersion;

  /** What a sent message replies to. */
  replyTo?: StoredReply;

  /** The message acted on. */
  message?: MessageCell;

  /** A single emoji. */
  emoji?: string;

  /** A rendered control's text. */
  readonly target?: { readonly value?: string };
}

/** Where a rendered composer keeps the reply and the edit it is composing. */
export interface ComposerState {
  /** The message the next send replies to in the main conversation. */
  replyTo?: MessageCell;

  /** The message being edited. */
  editing?: MessageCell;

  /** The thread shown beside the conversation, by its root. */
  thread?: MessageCell;
}

/** The cell holding a session's composer state. */
export type ComposerCell = Writable<
  ComposerState | Default<Record<PropertyKey, never>>
>;

/** The acts on a message, each performed by a handler of its own. */
type MessageAct = "send" | "edit" | "delete" | "obliterate";

/**
 * The cell holding the outcome of each of the sender's message acts, by its
 * `requestId`: one instance per user, which no one else reads.
 */
export type MessageRequestsCell = Writable<
  | Record<string, MessageActOutcome>
  | Default<Record<PropertyKey, never>>
>;

/**
 * The cell holding why the session's latest message act was refused, which
 * the room's composer shows; empty once an act takes effect.
 */
export type ActRefusalCell = Writable<string>;

/** What a room asks of its viewer's manager's `joinRoom`: the room itself. */
export interface JoinRoomRequest {
  /** The root explicitly declaring a room held inside a container. */
  container?: Cell<ChatContainer>;

  /** The room the viewer has joined. */
  room: Cell<ChatRoomLink>;
}

/**
 * Whether `catalog` keeps the room in `space` as one of its user's chats; a
 * catalog that doesn't read as one keeps none.
 */
export const listsRoomIn = (
  catalog: unknown,
  space: string | undefined,
): boolean => {
  if (!isSharedSpaceCatalog(catalog) || space === undefined) return false;
  const entry = catalog.entries[space];
  return entry?.kind === CHAT_ROOM_OFFER_KIND && entry.state === "saved";
};

/**
 * The room's records, and a rendered control's bindings, as every handler
 * that changes the room is bound to them.
 */
export interface RoomActState {
  /** The viewer's profile, which holds no value until it resolves. */
  myProfile: ProfileCell | undefined;

  /** The room's kind. */
  kind: ChatRoomKind;

  /** The room's messages. */
  messages: MessagesCell;

  /** Every message's reaction list. */
  reactionLists: ReactionListsCell;

  /** The requests the room has acted on. */
  requests: RequestsCell;

  /** The times the room has recorded something at. */
  usedTimes: UsedTimesCell;

  /** The room's recent activity. */
  activity: ActivityCell;

  /** The sender's outcomes, by `requestId`; absent where none are kept. */
  outcomes?: MessageRequestsCell;

  /**
   * Why the session's latest act was refused, which the composer shows;
   * absent where nothing shows it.
   */
  refusal?: ActRefusalCell;

  /** A rendered control's message: the one acted on, or replied to. */
  message?: MessageCell;

  /** Where a rendered control's reply is shown. */
  shownIn?: ShownIn;

  /**
   * The session's composer state. Every binding passes it: an optional cell
   * left unbound would read back as a handle into the binding itself.
   */
  composer: ComposerCell;

  /**
   * For a rendered composer's send, which reply it takes from the composer:
   * the main reply, or the open thread. Other sends take none from it.
   */
  replyFrom?: "replyTo" | "thread";

  /** A rendered control's emoji. */
  emoji?: string;

  /** A rendered reaction picker's open state, closed by a reaction. */
  pickerOpen?: Writable<boolean>;

  /** Whether this binding closes `pickerOpen`, which only a picker binds. */
  closesPicker?: boolean;

  /**
   * The room's policy, as `about.policy` links it, whose `ownersMayObliterate`
   * says whether an OWNER may obliterate; absent or unread, no OWNER may.
   */
  policy?: Cell<ChatRoomPolicy>;

  /**
   * Tells the viewer's manager the viewer has joined the room, as
   * `tellManagerJoined` does, in an event of its own; absent where nothing is
   * told. The act's own transaction reads nothing of the manager, which can
   * carry a label the room's space doesn't admit.
   */
  joined?: Stream<void>;

  /**
   * Drops what the room no longer keeps, in an event of its own: a binding of
   * `commitSend` that `forgets`. Absent where nothing is dropped. The act's
   * own transaction reads none of the lists it drops from, so two acts at
   * once don't collide over them.
   */
  expire?: Stream<RoomStreamEvent>;

  /**
   * Whether this binding drops what the room no longer keeps, as
   * `forgetExpired()` does, rather than acting. It writes only records every
   * act writes, whose write policies name the act handlers, so it is a
   * binding of one of them.
   */
  forgets?: boolean;

  /** Where the activity's numbering stands; read by a binding that `forgets`. */
  counters?: ActivityCountersCell;
}

/** What `tellManagerJoined` is bound to. */
export interface ManagerJoinState {
  /**
   * Whether the viewer's manager can take the viewer into the room: the
   * viewer has a manager and the room is standalone or its container's
   * declared conversation. Absent, it can't.
   */
  canJoin?: boolean;

  /** The container's declaration, for a room held inside another space. */
  container?: Cell<ChatContainer>;

  /** The viewer's manager's `joinRoom`, when `canJoin` holds. */
  joinRoom?: Stream<JoinRoomRequest>;

  /** The room itself, as the viewer's manager links it. */
  self?: Cell<ChatRoomLink>;
}

/**
 * Tells the viewer's manager the viewer has joined the room. The manager's
 * own event checks its private catalog and leaves an already listed room
 * unchanged, so catalog reads stay in the manager's event. A room's acts send
 * it an event once they have recorded what the viewer wrote.
 */
export const tellManagerJoined = handler<void, ManagerJoinState>(
  (_event, { canJoin, container, joinRoom, self }) => {
    if (canJoin !== true || joinRoom === undefined || self === undefined) {
      return;
    }
    joinRoom.send({ room: self, container });
  },
);

/**
 * Records that the act `requestId` took effect, clears the session's shown
 * refusal, and has `expire` drop what the room no longer keeps, in an event of
 * its own.
 */
const actDone = (state: RoomActState, requestId: string): void => {
  state.outcomes?.key(requestId).set({ status: "done" });
  state.refusal?.set("");
  state.expire?.send({});
};

/**
 * Records that the act `requestId` was refused, with `code` and `reason`, and
 * shows the reason to the session. Nothing else is written: a refusal leaves
 * the room's shared record as it is. A request already done keeps its
 * outcome, and shows nothing: a replay of an act that took effect is not
 * refused, whatever the state it arrives in.
 */
const refuseAct = (
  state: RoomActState,
  requestId: string,
  code: MessageActRefusalCode,
  reason: string,
): void => {
  const outcome = state.outcomes?.key(requestId);
  if (outcome?.get()?.status === "done") return;
  outcome?.set({ status: "refused", reason, code });
  state.refusal?.set(reason);
};

/**
 * Helper for the act handlers, which refuses an act whose sender can't act in
 * the room: one whose profile hasn't resolved, who isn't signed in, or whose
 * access to the room's space is known and doesn't let them write. Returns
 * whether it refused.
 */
const refuseUnableSender = (
  state: RoomActState,
  requestId: string,
  profileResolved: boolean,
  sender: string | undefined,
): boolean => {
  if (!profileResolved) {
    refuseAct(
      state,
      requestId,
      "no-profile",
      "Acting in a chat needs a profile, and yours hasn't resolved.",
    );
    return true;
  }
  const level = spaceAccess(state.messages);
  if (sender === undefined || level === "none" || level === "READ") {
    refuseAct(
      state,
      requestId,
      "not-member",
      "You can't write in this chat.",
    );
    return true;
  }
  return false;
};

/** The reason an act's time is refused for, as a person reads it. */
const OUT_OF_WINDOW = "The time it was made at is outside this chat's window.";

/**
 * Performs one message act: send, edit, delete, or obliterate. An act that
 * breaks the rules `ChatRoomOutput` states for its stream is refused, which
 * records the refusal in the sender's outcomes and nothing else; otherwise it
 * records the change, an activity entry, the request, and its outcome, all in
 * one transaction.
 */
const performMessageAct = (
  op: MessageAct,
  event: RoomStreamEvent,
  state: RoomActState,
): void => {
  const {
    myProfile,
    kind,
    messages,
    reactionLists,
    requests,
    usedTimes,
    activity,
    composer,
  } = state;
  const requestId = event?.requestId ?? eventKey();
  const refuse = (code: MessageActRefusalCode, reason: string): void =>
    refuseAct(state, requestId, code, reason);
  const profile = myProfile?.resolveAsCell();
  const sender = currentPrincipal();
  if (
    refuseUnableSender(
      state,
      requestId,
      profile?.get() !== undefined,
      sender,
    ) ||
    sender === undefined
  ) {
    return;
  }
  const requestKey = requestKeyOf(sender, requestId);
  if (actedOn(requests, requestKey)) return;
  const clock = clockNsec();
  const offset = tickOffsetOf(sender);
  const typed = event?.target?.value;
  const version: ChatMessageVersion | undefined = event?.version ??
    (typeof typed === "string"
      ? { body: typed.trim(), sentAt: epochNsec(clock) }
      : undefined);

  if (op === "send") {
    if (version === undefined || !isValidBody(version.body)) {
      refuse("invalid-body", "A message needs some text.");
      return;
    }
    // A send arriving again after its memo has expired finds the message it
    // made, and changes nothing.
    if (messages.elementById(requestKey).get() !== undefined) {
      rememberRequest(requests, requestKey, clock);
      actDone(state, requestId);
      return;
    }
    const composing = composer.get();
    const composed = state.replyFrom === "thread"
      ? composing?.thread
      : state.replyFrom === "replyTo"
      ? composing?.replyTo
      : undefined;
    // A cleared link still reads back as a cell, holding nothing.
    const fromComposer = composed?.get() === undefined ? undefined : composed;
    const replyCell = (event?.replyTo?.message ?? state.message ?? fromComposer)
      ?.resolveAsCell();
    const shownIn = event?.replyTo?.shownIn ?? state.shownIn ?? "main";
    // Only a reply reads the messages, to find its target among them.
    const target = replyCell === undefined
      ? undefined
      : entryFor(messageEntries(messages), replyCell);
    if (replyCell !== undefined) {
      if (target === undefined) {
        refuse("bad-reply", "The message replied to isn't in this chat.");
        return;
      }
      if (isDeleted(target.record)) {
        refuse("deleted-target", "The message replied to was deleted.");
        return;
      }
      if (!SHOWN_IN.includes(shownIn)) {
        refuse("bad-reply", "A reply is shown in the main chat or a thread.");
        return;
      }
      if (shownIn === "main" && !isInMain(target)) {
        refuse(
          "bad-reply",
          "A message shown only in a thread takes its replies there.",
        );
        return;
      }
    }
    const sentAt = claimTime(
      usedTimes,
      clock,
      offset,
      nsecOf(version.sentAt),
      target?.sentAt,
    );
    const loggedAt = sentAt === undefined
      ? undefined
      : claimTime(usedTimes, clock, offset);
    if (sentAt === undefined || loggedAt === undefined) {
      refuse("out-of-window", OUT_OF_WINDOW);
      return;
    }
    // The message and its reactions are addressed by the request that sent
    // it, which names one message in every session.
    const record = messages.elementById(requestKey);
    // A message may link only a list that exists, so the list is written
    // before the message links it.
    const reactions = reactionLists.elementById(requestKey);
    reactions.set([]);
    record.set({
      authorProfile: profile,
      body: version.body,
      sentAt,
      earlierVersions: [],
      ...(replyCell === undefined
        ? {}
        : { replyTo: { message: replyCell, shownIn } }),
      reactions,
    } as SentMessage);
    messages.addUnique(record);
    appendActivity(activity, loggedAt, requestId, record);
    rememberRequest(requests, requestKey, clock);
    actDone(state, requestId);
    if (state.replyFrom === "replyTo" && composing?.replyTo !== undefined) {
      composer.key("replyTo").set(undefined);
    }
    state.joined?.send();
    return;
  }

  const target = (event?.message ?? state.message)?.resolveAsCell();
  const entry = entryFor(messageEntries(messages), target);
  if (target === undefined || entry === undefined) {
    refuse("unknown-target", "That message isn't in this chat.");
    return;
  }
  const current = entry.record;
  const ownersMayObliterate = ownersMayObliterateBy(state.policy);
  const rights = messageRightsOf(
    current,
    profile,
    kind,
    isOwnerOf(messages),
    ownersMayObliterate,
  );
  const deletionObliterates = op === "delete" &&
    FABRICHAT_POLICY.deletionIsObliteration;

  if (op === "obliterate" || deletionObliterates) {
    if (current.authorProfile === undefined) {
      refuse("deleted-target", "That message was already removed.");
      return;
    }
    if (op === "delete" && isDeleted(current)) {
      refuse("deleted-target", "That message was already deleted.");
      return;
    }
    if (!(op === "delete" ? rights.canDelete : rights.canObliterate)) {
      refuse(
        "not-allowed",
        op === "delete"
          ? "Only its author can delete a message."
          : obliterationRefusal(kind, ownersMayObliterate),
      );
      return;
    }
    const editedAt = claimTime(usedTimes, clock, offset);
    const loggedAt = editedAt === undefined
      ? undefined
      : claimTime(usedTimes, clock, offset);
    if (editedAt === undefined || loggedAt === undefined) {
      refuse("out-of-window", OUT_OF_WINDOW);
      return;
    }
    current.reactions?.set([]);
    target.set({
      body: { deleted: true },
      sentAt: current.sentAt,
      editedAt,
      earlierVersions: [],
      ...(current.replyTo === undefined ? {} : { replyTo: current.replyTo }),
    } as SentMessage);
    appendActivity(activity, loggedAt, requestId, target, target);
    rememberRequest(requests, requestKey, clock);
    actDone(state, requestId);
    return;
  }

  if (isDeleted(current)) {
    refuse("deleted-target", "That message was deleted.");
    return;
  }
  if (!(op === "delete" ? rights.canDelete : rights.canEdit)) {
    refuse(
      "not-allowed",
      op === "delete"
        ? "Only its author can delete a message."
        : "Only its author can edit a message.",
    );
    return;
  }
  const kept: ChatMessageVersion[] = FABRICHAT_POLICY.keepsHistory
    ? [...(current.earlierVersions ?? []), {
      body: current.body as string,
      sentAt: current.editedAt ?? current.sentAt,
    }]
    : [];

  if (op === "delete") {
    const editedAt = claimTime(usedTimes, clock, offset);
    const loggedAt = editedAt === undefined
      ? undefined
      : claimTime(usedTimes, clock, offset);
    if (editedAt === undefined || loggedAt === undefined) {
      refuse("out-of-window", OUT_OF_WINDOW);
      return;
    }
    current.reactions?.set([]);
    target.set({
      authorProfile: current.authorProfile,
      body: { deleted: true },
      sentAt: current.sentAt,
      editedAt,
      earlierVersions: kept,
      ...(current.replyTo === undefined ? {} : { replyTo: current.replyTo }),
    } as SentMessage);
    appendActivity(activity, loggedAt, requestId, target);
    rememberRequest(requests, requestKey, clock);
    actDone(state, requestId);
    return;
  }

  if (version === undefined || !isValidBody(version.body)) {
    refuse("invalid-body", "A message needs some text.");
    return;
  }
  const editedAt = claimTime(usedTimes, clock, offset, nsecOf(version.sentAt));
  const loggedAt = editedAt === undefined
    ? undefined
    : claimTime(usedTimes, clock, offset);
  if (editedAt === undefined || loggedAt === undefined) {
    refuse("out-of-window", OUT_OF_WINDOW);
    return;
  }
  target.set({
    authorProfile: current.authorProfile,
    body: version.body,
    sentAt: current.sentAt,
    editedAt,
    earlierVersions: kept,
    ...(current.replyTo === undefined ? {} : { replyTo: current.replyTo }),
    ...(current.reactions === undefined
      ? {}
      : { reactions: current.reactions }),
  } as SentMessage);
  appendActivity(activity, loggedAt, requestId, target);
  rememberRequest(requests, requestKey, clock);
  actDone(state, requestId);
  const editing = composer.get()?.editing;
  if (editing !== undefined && equals(editing, target)) {
    composer.key("editing").set(undefined);
  }
};

/**
 * Adds or removes the sender's reaction to a message. Adding one already
 * there, or removing one that isn't, changes nothing, and is done. A reaction
 * is kept at an address within its message's list derived from its reactor
 * and its emoji, so one person's one reaction has a single address in every
 * session. A refused reaction records only the refusal in the sender's
 * outcomes.
 */
const performReactionAct = (
  op: "add" | "remove",
  event: RoomStreamEvent,
  state: RoomActState,
): void => {
  const { myProfile, messages, requests, usedTimes, activity } = state;
  const requestId = event?.requestId ?? eventKey();
  const refuse = (code: MessageActRefusalCode, reason: string): void =>
    refuseAct(state, requestId, code, reason);
  const profile = myProfile?.resolveAsCell();
  const sender = currentPrincipal();
  // A reaction's address derives from its reactor's profile.
  const reactorKey = profile === undefined ? undefined : entityKeyOf(profile);
  if (
    refuseUnableSender(
      state,
      requestId,
      profile?.get() !== undefined && reactorKey !== undefined,
      sender,
    ) || sender === undefined
  ) {
    return;
  }
  const typed = event?.target?.value?.trim();
  const emoji = event?.emoji ?? state.emoji ?? typed;
  if (!isSingleEmoji(emoji)) {
    refuse("invalid-body", "A reaction is a single emoji.");
    return;
  }
  const requestKey = requestKeyOf(sender, requestId);
  if (actedOn(requests, requestKey)) return;
  const target = (event?.message ?? state.message)?.resolveAsCell();
  const entry = entryFor(messageEntries(messages), target);
  if (target === undefined || entry === undefined) {
    refuse("unknown-target", "That message isn't in this chat.");
    return;
  }
  const list = entry.record.reactions;
  if (isDeleted(entry.record) || list === undefined) {
    refuse("deleted-target", "That message was deleted.");
    return;
  }
  const clock = clockNsec();
  const offset = tickOffsetOf(sender);
  if (state.closesPicker === true) state.pickerOpen?.set(false);
  const reactionKey = JSON.stringify([reactorKey, emoji]);
  const mine = list.elementById(reactionKey);
  const present = mine.get() !== undefined;
  if (op === "add" && !present) {
    const sentAt = claimTime(usedTimes, clock, offset);
    const loggedAt = sentAt === undefined
      ? undefined
      : claimTime(usedTimes, clock, offset);
    if (sentAt === undefined || loggedAt === undefined) {
      refuse("out-of-window", OUT_OF_WINDOW);
      return;
    }
    mine.set({ reactorProfile: profile, emoji, sentAt } as SentReaction);
    list.addUnique(mine);
    appendActivity(activity, loggedAt, requestId, target);
    state.joined?.send();
  }
  if (op === "remove" && present) {
    const loggedAt = claimTime(usedTimes, clock, offset);
    if (loggedAt === undefined) {
      refuse("out-of-window", OUT_OF_WINDOW);
      return;
    }
    list.removeByValue(mine);
    // The record outlives its place in the list, and it is the record that
    // says whether the reaction is there, so removing it clears it too.
    const cleared: Writable<SentReaction | undefined> = list.elementById(
      reactionKey,
    );
    cleared.set(undefined);
    appendActivity(activity, loggedAt, requestId, target);
  }
  rememberRequest(requests, requestKey, clock);
  actDone(state, requestId);
};

/**
 * Sends a message, from `ChatSendSurface`; bound so that it `forgets`, drops what the
 * room no longer keeps instead (`forgetExpired()`).
 */
export const commitSend = handler<RoomStreamEvent, RoomActState>(
  (event, state) =>
    state.forgets === true
      ? forgetExpired(state)
      : performMessageAct("send", event, state),
);

/** Edits the sender's message, from `ChatEditSurface`. */
export const commitEdit = handler<RoomStreamEvent, RoomActState>(
  (event, state) => performMessageAct("edit", event, state),
);

/** Deletes a message, from `ChatDeleteSurface`. */
export const commitDelete = handler<RoomStreamEvent, RoomActState>(
  (event, state) => performMessageAct("delete", event, state),
);

/** Obliterates a message, from `ChatObliterateSurface`. */
export const commitObliterate = handler<RoomStreamEvent, RoomActState>(
  (event, state) => performMessageAct("obliterate", event, state),
);

/** Adds the sender's reaction, from `ChatReactSurface`. */
export const commitSendReaction = handler<RoomStreamEvent, RoomActState>(
  (event, state) => performReactionAct("add", event, state),
);

/** Removes the sender's reaction, from `ChatReactSurface`. */
export const commitDeleteReaction = handler<RoomStreamEvent, RoomActState>(
  (event, state) => performReactionAct("remove", event, state),
);

/**
 * Drops what the room no longer keeps: the requests and used times older than
 * the request memory, and the activity entries older than the activity
 * window. A binding of `commitSend` that `forgets` runs it, in an event every
 * act sends once it has recorded what it did, so the act's own transaction
 * reads none of these lists whole, and one act never collides with another
 * over them. It writes nothing while nothing has expired.
 *
 * An entry expired anywhere in the activity is cleared, and counts toward
 * `expiredThrough`. Only the run of cleared entries at the front leaves the
 * list, and `nextSeq` moves past it, so no entry still in the list changes its
 * `seq` (`numberActivity()`).
 */
const forgetExpired = (
  { requests, usedTimes, activity, counters }: RoomActState,
): void => {
  if (counters === undefined) return;
  const clock = clockNsec();
  const forgotten = clock - REQUEST_MEMORY_NSEC;
  forgetBefore(requests, (memo) => memo.key, forgotten);
  forgetBefore(usedTimes, (used) => String(nsecOf(used.at)), forgotten);

  const horizon = clock - FABRICHAT_POLICY.recentActivityWindowNsec.value;
  const record = counters.elementById(NUMBERING_KEY);
  const numbering = (record.get() ?? NO_ACTIVITY) as ActivityCounters;
  const numbered = numberActivity(
    (activity.get() ?? []) as ActivityRecord[],
    numbering,
  );
  const expired = numbered.map(({ entry }) =>
    !isCleared(entry) && entry.at !== undefined && nsecOf(entry.at) < horizon
  );
  const expiredThrough = numbered.reduce(
    (highest, { seq }, index) =>
      expired[index] ? Math.max(highest, seq) : highest,
    numbering.expiredThrough,
  );
  const standing = numbered.findIndex(({ entry }, index) =>
    !isCleared(entry) && !expired[index]
  );
  const dropped = standing === -1 ? numbered.length : standing;
  // Every entry's cell is taken before the list changes, since a removal
  // moves the places after it.
  const cells = numbered.map((_, index) => {
    const cell: Writable<SentActivity> = activity.key(index).resolveAsCell();
    return cell;
  });
  cells.forEach((cell, index) => {
    if (index < dropped) {
      // An entry that leaves the list is cleared whole: nothing reads it.
      activity.removeByValue(cell);
      const removed: Writable<SentActivity | undefined> = cell;
      removed.set(undefined);
    } else if (expired[index]) {
      cell.set(clearedFrom(numbered[index].entry) as SentActivity);
    }
  });
  if (dropped === 0 && expiredThrough === numbering.expiredThrough) return;
  record.set({
    nextSeq: dropped === 0 ? numbering.nextSeq : numbered[dropped - 1].seq + 1,
    expiredThrough,
  } as StoredActivityCounters);
  counters.addUnique(record);
};

/** What `commitWindow` is bound to. */
export interface WindowActState {
  /** Whether the binding opens (or moves) a window, or closes one. */
  op: "open" | "close";

  /** The room's messages. */
  messages: MessagesCell;

  /** The session's windows. */
  windows: WindowsCell;
}

/** A window request, whose thread root is one of the room's messages. */
export interface RoomWindowEvent extends Omit<WindowEvent, "root"> {
  /** The root of the thread to show; absent for the main conversation. */
  root?: MessageCell;
}

/**
 * Opens, moves, or closes one of the sending session's windows onto the
 * messages. It changes nothing but that session's windows, so it keeps no
 * request memory: repeating a request sets or removes the same window again.
 */
export const commitWindow = handler<RoomWindowEvent, WindowActState>(
  (event, { op, messages, windows }) => {
    const windowId = event?.windowId;
    if (typeof windowId !== "string" || windowId === "") return;
    const current = (windows.get() ?? {}) as ChatMessageWindows;
    if (op === "close") {
      if (!(windowId in current)) return;
      windows.set(
        Object.fromEntries(
          Object.entries(current).filter(([id]) => id !== windowId),
        ),
      );
      return;
    }
    const request = event;
    if (
      !(windowId in current) &&
      Object.keys(current).length >= FABRICHAT_POLICY.maxOpenWindows
    ) {
      return;
    }
    const entries = messageEntries(messages);
    const root = request.root?.resolveAsCell();
    const rootEntry = root === undefined ? undefined : entryFor(entries, root);
    if (root !== undefined && rootEntry === undefined) return;
    const view = rootEntry === undefined
      ? entries.filter(isInMain).sort(compareEntries)
      : threadView(entries, rootEntry.key);
    if (view === undefined) return;
    const anchor = anchorOf(request.from);
    if (anchor === undefined) return;
    const count = windowCount(request.count, FABRICHAT_POLICY.maxWindowCount);
    const slice = windowSlice(view, anchor, count);
    if (slice === undefined) return;
    windows.key(windowId).set({
      requestId: request.requestId,
      ...(root === undefined ? {} : { root }),
      messages: view.slice(slice.start, slice.end).map((entry) =>
        entry.cell.resolveAsCell()
      ),
      hasOlder: slice.hasOlder,
      hasNewer: slice.hasNewer,
    });
  },
);

/**
 * An event on the room's `setTitle`. A rendered control sends the text it
 * holds as `target.value`, and no request id, which the room then mints.
 */
export interface SetTitleEvent {
  /**
   * Chosen by the sender, and unique among its retitles. The outcome is
   * recorded under it, and sending the same event again with it changes
   * nothing.
   */
  requestId?: string;

  /** The new title. */
  title?: string;

  /** A rendered control's text. */
  readonly target?: { readonly value?: string };
}

/** What `commitSetTitle` is bound to. */
export interface SetTitleState {
  /**
   * The room's title as a member last set it; absent for a room whose title
   * no member sets.
   */
  titles?: TitlesCell;

  /**
   * Whether the room is one a manager created in a space of its own. A
   * space's own chat is shown by its space's name.
   */
  ownSpace: boolean;

  /** The room's messages, which name the room's space. */
  messages: MessagesCell;

  /** The sender's retitles' outcomes. */
  outcomes: TitleRequestsCell;

  /**
   * Why the session's latest retitle was refused, which the rendered control
   * shows; empty once one takes effect.
   */
  refusal: Writable<string>;

  /**
   * Tells the viewer's manager the viewer has joined the room, as
   * `tellManagerJoined` does, in an event of its own, which brings the title
   * the manager's catalog lists the room under up to the new one; absent where
   * nothing is told. The retitle's own transaction reads nothing of the
   * manager.
   */
  joined?: Stream<void>;
}

/**
 * Sets the room's title, which every member shares, from a trusted gesture on
 * `ChatRetitleSurface`. Any member who can write in the room may, in a group
 * room or a direct one. The outcome is recorded under the event's
 * `requestId` in the sender's own outcomes, and a refusal leaves the title as
 * it is. A retitle that takes effect then tells the sender's manager, as a
 * write in the room does, so the catalog lists the room under the new title.
 */
export const commitSetTitle = handler<SetTitleEvent, SetTitleState>(
  (event, { titles, ownSpace, messages, outcomes, refusal, joined }) => {
    const requestId = event?.requestId ?? eventKey();
    if (outcomes.key(requestId).get() !== undefined) return;
    const refuse = (code: SetTitleRefusalCode, reason: string): void => {
      outcomes.key(requestId).set({ status: "refused", reason, code });
      refusal.set(reason);
    };
    if (!ownSpace || titles === undefined) {
      refuse("fixed-title", "This chat is named by its space.");
      return;
    }
    // A level not known yet is left to the space's own access list, which
    // refuses the write where it doesn't admit it.
    const level = spaceAccess(messages);
    if (
      currentPrincipal() === undefined || level === "none" || level === "READ"
    ) {
      refuse("not-member", "You can't write in this chat.");
      return;
    }
    const proposed = event?.title ?? event?.target?.value;
    const title = typeof proposed === "string" ? proposed.trim() : "";
    if (title === "") {
      refuse("invalid-title", "A chat's title needs some text.");
      return;
    }
    const record = titles.elementById(TITLE_KEY);
    record.set({ title } as StoredTitle);
    titles.addUnique(record);
    outcomes.key(requestId).set({ status: "done" });
    refusal.set("");
    joined?.send();
  },
);
