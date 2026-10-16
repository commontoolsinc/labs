# ChatRoomOutput

The result of a chat room: what a room piece offers everyone the room's space
admits. It is the contract that placements, adapters, and clients read, and it
is named for the role rather than for an implementation.
[`FabriChatRoom`](FabriChatRoom.md) is an implementation of it: its result
satisfies `ChatRoomOutput`, and another pattern that satisfies it can fill the
same role. Everything in this document binds every implementation.

```ts
// Shown for illustration only.
interface ChatRoomOutput {
  about: ChatRoomAbout;

  /** What the room recorded recently, in `seq` order. */
  recentActivity: ChatRoomActivity[];

  /** The room's participants, plus any author it doesn't list. */
  participants: Cell<ChatProfile>[];

  /** Those who joined the room itself, in the order they joined. */
  roster: Cell<ChatProfile>[];

  /** Each participant's profile, with the principal it attests. */
  participantEntries: PerSession<
    { profile: Cell<ChatProfile>; principal?: string }[]
  >;

  /** The principals `participantEntries` holds, once each. */
  participantPrincipals: PerSession<string[]>;

  /** Adds a profile to those who joined the room, once. */
  addParticipant: Stream<{ profile: Cell<ChatProfile> }>;

  /** The highest `seq` dropped from `recentActivity` for age; 0 for none. */
  recentActivityExpiredThrough: number;

  /** The room's messages: facts, the newest, and this session's windows. */
  messages: ChatMessageList;

  /** `messages.openWindow` and `messages.closeWindow`, at the top level. */
  openWindow: ChatMessageList["openWindow"];
  closeWindow: ChatMessageList["closeWindow"];

  /** Whether this reader can send, edit, delete, and react. */
  canSend: boolean;

  /** Who is reading the room: their profile, its principal, their access. */
  viewer: {
    profile?: Cell<ChatProfile>;
    principal?: string;
    role?: "OWNER" | "WRITE" | "READ" | "none";
  };

  /** What this reader may do to each message, oldest first. */
  messageRights: {
    message: Cell<ChatMessage>;
    canEdit: boolean;
    canDelete: boolean;
    canObliterate: boolean;
  }[];

  sendMessage: Stream<{
    requestId: string;
    version: ChatMessageVersion;
    replyTo?: ChatReply;
  }>;
  editMessage: Stream<{
    requestId: string;
    message: Cell<ChatMessage>;
    version: ChatMessageVersion;
  }>;
  deleteMessage: Stream<{ requestId: string; message: Cell<ChatMessage> }>;
  obliterateMessage: Stream<{
    requestId: string;
    message: Cell<ChatMessage>;
  }>;
  sendReaction: Stream<{
    requestId: string;
    message: Cell<ChatMessage>;
    emoji: string;
  }>;
  deleteReaction: Stream<{
    requestId: string;
    message: Cell<ChatMessage>;
    emoji: string;
  }>;

  /**
   * Admits someone to the room's space, from a trusted gesture, and has the
   * reader's manager tell them of the room.
   */
  addMember: Stream<{
    requestId: string;
    target?: { value?: string; name?: Cell<ChatProfile> };
    profile?: Cell<ChatProfile>;
  }>;

  /** Whether this reader can add someone to the room's space. */
  canAdd: boolean;

  /** The outcome of each of this reader's adds, by its `requestId`. */
  addRequests: Record<
    string,
    | {
      status: "done";
      delivery?: "offered" | "noticed" | "access-only";
      deliveryRefusal?: string;
    }
    | { status: "refused"; reason: string; code?: "direct-room" }
  >;

  /** The outcome of each of this reader's message acts, by its `requestId`. */
  messageRequests: Record<
    string,
    | { status: "done" }
    | {
      status: "refused";
      reason: string;
      code:
        | "no-profile"
        | "not-member"
        | "invalid-body"
        | "out-of-window"
        | "bad-reply"
        | "deleted-target"
        | "unknown-target"
        | "not-allowed";
    }
  >;

  /** Sets the room's title, which every member shares. */
  setTitle: Stream<{ requestId: string; title: string }>;

  /** The outcome of each of this reader's retitles, by its `requestId`. */
  titleRequests: Record<
    string,
    | { status: "done" }
    | {
      status: "refused";
      reason: string;
      code: "not-member" | "invalid-title" | "fixed-title";
    }
  >;
  [UI]: VNode;
  [VIEWS]: { room: object };
}
```

## Where a room lives

A room is the chat of a social space (see [social
spaces](README.md#social-spaces)): a piece in that space, and a space has at
most one. A conversation the user starts, direct or group, gets a space of its
own, which the user's chat manager ([`ChatManagerOutput`](ChatManagerOutput.md))
creates with the room as its root, and never a placement, an adapter, or a
container. Such a room is a social space in its own right: opening its space
shows the room, and the room lists the space's participants itself. The room
is at the address the space's genesis reserves for a root, and the space
declares itself a `fabrichat-room`
([space kinds](../../features/space-kinds.md)), which is how a host vetting an
offer of the room tells what the space is. An existing social space's chat is
created in it by whatever sets the space up, and that space's root stays its
own. Either way, a room can also be shown in any other social space, through a
placement and an adapter, and there the other space's root stays the root.

When the manager creates a space for a conversation, the creator and each
other member hold OWNER. Its access list MUST NOT contain the `"*"`
wildcard, so a room is not open to principals its space hasn't admitted,
except for a group room its creator makes joinable by its link (see
[`createGroup`](ChatManagerOutput.md#creategrouprequestid-string-members-string-profiles-cellchatprofile-title-string-joinablebylink-boolean)):
that one grants `"*"` WRITE, and its address is all that keeps it private. A
direct room is never joinable by its link. A room in
an existing space takes the space's access list as it is, and adds nothing to
it.

## Membership

The room space's access list is the room's membership, and a member is any
principal it admits. Every action on a room, reading a window of its messages
included, appends an event in the room's space, which needs WRITE. A member with
only READ can read the newest messages, through the room's `messages.latest`,
which needs no event, but can't open other windows, send, or react.

A room keeps no membership of its own. Who is in its space, and with what
access, is the space's business: its access list changes through the space's
own tools, such as the CLI's `cf acl`, and, for a group room in a space of its
own, through the room's [`addMember`](#addmemberrequestid-string-target--value-string--profile-cellchatprofile), from
which any OWNER admits someone else as OWNER. Its root lists its
participants' profiles, claims each member contributes by joining the space: a
room in a space of its own is that root, and keeps them itself, each added
through [`addParticipant`](#addparticipantprofile-cellchatprofile); a room in
an existing social space reads them from that space's root
(`wish({ query: "#default" })`), then lists those who joined the room itself.
The two can disagree:
a member who has never joined has no entry, and an entry whose principal has
lost access stays until it's cleaned up. A consumer MUST NOT treat an entry as
proof of access.

A direct room's space is meant to keep its two members. Nothing in the room adds
anyone, but the room can't stop its space's OWNER from granting someone else
access, and a direct room whose space has grown stays `kind: "direct"`. A person
leaves a conversation by forgetting it in their manager, or by leaving its
space.

## Facts

- **`about`** is a [`ChatRoomAbout`](ChatRoomAbout.md), set when the room is
  created. Its `title` changes through
  [`setTitle`](#settitlerequestid-string-title-string), and the rest of it
  never does.
- **Messages.** The room holds its [`ChatMessage`](ChatMessage.md)s, ordered by
  `sentAt`, which is unique in the room. A client reads the newest of them from
  `messages`, and the rest through windows (see
  [`ChatMessageList`](ChatMessageList.md#windows)), a window at a time. An
  obliterated message stays as a tombstone. Each version of a message is labeled
  `authored-by` the principal who recorded it. A message changes only through
  `editMessage`, `deleteMessage`, and `obliterateMessage`, and is never removed.
  A deleted message accepts nothing further except obliteration (see [deleted
  messages](ChatMessage.md#deleted-messages)).
- **Reactions** live on their messages, as each message's `reactions`
  ([`ChatReaction`](ChatReaction.md)), each labeled `authored-by` its reactor. A
  reaction is removed only by its own reactor, or with its message when it is
  obliterated.
- The room stores no names or avatars. Messages and reactions link people's
  profiles ([`ChatProfile`](ChatProfile.md)) and copy nothing from them.
- **`participants`** are links to profiles, compared with `equals()`: the
  profiles its space's root lists, as [membership](#membership) says, plus any
  author none of them is, each once. They are not proof of access.
- **`roster`** holds the profiles of those who joined the room itself, each
  added once through
  [`addParticipant`](#addparticipantprofile-cellchatprofile), in the order they
  were added: for a room in a space of its own, its space's participants. It
  lists no author it doesn't hold, so it is read from what the room stores
  alone, without reading the room's messages, which is how a chat manager reads
  who is in each of its user's rooms (see
  [`ChatIndexEntry`](ChatIndexEntry.md#fields)). Like `participants`, it is a
  claim, not proof of access.
- **`participantEntries`** pairs each of `participants` with the principal it
  stands for: one entry per participant, in the order of `participants`,
  holding its `profile` and, as `principal`, the principal its profile's
  `represents-principal` label attests. An entry has no `principal` when its
  profile attests none, or when the label can't be read where the list is
  derived, as when the profile's space refuses the reader, so two readers can
  read different principals for the same participant. It is derived for each
  reader and is best effort, not an access list, and like `participants` it is
  a claim, not proof of access. A client uses it to name each participant and
  to tell which of them is the reader, whose entry holds the reader's own
  principal.
- **`participantPrincipals`** is derivable from `participantEntries`: each
  `principal` the entries hold, once, in the order of `participants`. Like the
  entries, it is a best-effort list of who is already in the room, not an
  access list. A client uses it to leave the people already in the room out of
  its own add control.
- **`messages`** is a [`ChatMessageList`](ChatMessageList.md): how many messages
  the room holds, the span of their times, `latest`, the newest messages of
  the main conversation, and `threads`, each thread's reply count and latest
  reply time, which every member can read, a READ member included. It also
  holds the reading session's own windows onto the messages, and the streams
  that open and close them.
- **`openWindow`** and **`closeWindow`** are `messages.openWindow` and
  `messages.closeWindow` themselves, the same streams offered again at the
  room's top level, for a client that sends only to a view's own streams. A
  window either one opens is in `messages.windows`, so such a client reads a
  thread, or pages the main conversation, through the room alone (see
  [`ChatMessageList`](ChatMessageList.md#windows)).
- **`canSend`** says whether the reader can send, edit, delete, and react right
  now: their access is WRITE or OWNER, and their profile resolves. It lets a
  client tell a READ member why their gestures would be refused before they
  make one.
- **`viewer`** says who is reading the room. Its `profile` is the reader's
  profile, absent until it resolves, as a link to the profile itself: the link
  `sendMessage` records as a message's `authorProfile`, so a client tells the
  reader's own messages from the rest by comparing the two links, and finds
  the reader among `participants` the same way. Its `principal` is the
  principal that profile's `represents-principal` label attests, absent where
  it attests none or the label can't be read, as for `participantEntries`. Its
  `role` is the reader's access to the room's space, as the space's access
  list grants it (`OWNER`, `WRITE`, `READ`, or `none`), absent while that
  isn't known. Like `participantEntries`, the profile and the principal are
  claims, not proof of access.
- **`messageRights`** says what the reader may do to each of the room's
  messages: one entry per message, oldest first, holding the `message`, as the
  link `messages.latest` holds for it, and `canEdit`, `canDelete`, and
  `canObliterate`, decided by the rules the streams below admit an event by, so
  a client offers exactly the acts the room would take. Every entry is all
  `false` while `canSend` doesn't hold.
- **`canAdd`** says whether the reader can add someone to the room's space: the
  room is a group room in a space of its own, and their access is OWNER. It is
  false in a direct room, whose space keeps its two members, and in a space's
  own chat. A client offers its own add control only where it holds.
- **`addRequests`** holds the outcome of each of the reader's
  [`addMember`](#addmemberrequestid-string-target--value-string--profile-cellchatprofile)
  requests, by its `requestId`, and for each add that is done, how the person
  added was told of the room, once that is decided. It reads the verdicts from
  the reader's own manager, so it is the reader's alone, like the outcomes it
  holds.
- **`messageRequests`** holds the outcome of each of the reader's message acts,
  by its `requestId`: `sendMessage`, `editMessage`, `deleteMessage`,
  `obliterateMessage`, `sendReaction`, and `deleteReaction`. An act that takes
  effect, or has nothing left to change, is `done`. One the room refuses is
  `refused`, with a `reason` for a person to read and a `code` a client acts
  on:
  - `no-profile`: the reader's profile hasn't resolved, as where their Home
    lists no profile, so the act can't name them;
  - `not-member`: the reader can't write in the room, or isn't signed in;
  - `invalid-body`: a message with no text, or a reaction that isn't a single
    emoji;
  - `out-of-window`: the act's time is outside the room's window (see
    [recorded times](#recorded-times));
  - `bad-reply`: a reply to a message not in the room, or shown where its
    target can't be;
  - `deleted-target`: the message acted on, or replied to, is deleted;
  - `unknown-target`: the message acted on isn't in the room;
  - `not-allowed`: an act only the message's author, or an owner, may make.

  A request the room has already acted on, sent again, keeps the outcome it
  has. A rendered control's act carries no `requestId`, and its outcome is
  recorded under the event's own key.
- **`titleRequests`** holds the outcome of each of the reader's
  [`setTitle`](#settitlerequestid-string-title-string) requests, by its
  `requestId`. Like `addRequests`, it is the reader's alone.
- **`recentActivity`** is a log of what the room recorded recently: each message
  sent, edited, deleted, or obliterated, and each reaction added or removed, as
  a [`ChatRoomActivity`](ChatRoomActivity.md), in `seq` order. A client follows
  a room by reading it, rather than by comparing messages with what it had, and
  finds the message a send of its own produced there. It holds entries within
  the room's `recentActivityWindowNsec`.
- **`recentActivityExpiredThrough`** is the highest `seq` the room has dropped
  from `recentActivity` for age, or 0 if it has dropped none. A client compares
  it with the highest `seq` it has seen to tell whether it has missed anything
  (see [`ChatRoomActivity`](ChatRoomActivity.md#catching-up)).
- The lists here are projections. An implementation may keep each message's
  reactions as keyed collections, as long as what it offers satisfies these
  rules.

## Scopes

A room's fields fall into three [scopes](../scoped-cell-instances.md#summary),
plus two values computed for each reader, and the difference matters to a
client:

- **`PerSpace`**: one instance for the whole room, the same for everyone the
  room's space admits. That is nearly everything: `about`, the messages,
  `recentActivity` and `recentActivityExpiredThrough`, `participants` and
  `roster`, and the streams. These are the room: a link to the room names them,
  and passing the link around, to another component or another person, passes
  the room.
- **`PerSession`**: one instance per memory session in the room's space. That is
  `messages.windows`, the windows a session has opened onto the messages (see
  [`ChatMessageList`](ChatMessageList.md#scope)), and `participantEntries` and
  `participantPrincipals`, which each session derives under its own access.
  Passing the room's link to someone else never passes a session's windows:
  they read their own.
- **`PerUser`**: one instance per user, which follows them across sessions.
  That is only `addRequests`, `messageRequests`, and `titleRequests`, the
  outcomes of the reader's own adds, message acts, and retitles. No one else
  reads them.
- **Computed for each reader**: `canSend`, `canAdd`, `viewer`, and
  `messageRights`. Each is derived when it's read, from the reader's own access
  and profile, so each reader sees their own answer, and it needs no instance
  and no write. A placement carries `canSend` and `canAdd` as well.

Some values are derived when they're read, and stored nowhere, so reading them
needs no instance of anything: `participants` and `roster`, and in `messages`,
everything but `windows`. A session's windows come into being with its first
`openWindow`, so a READ member, who can't write, never has any, and can still
read `messages.latest`.

## Streams

Each stream is a one-way, asynchronous request to the room. Sending an event
finishes when the event is accepted, not when it takes effect, and returns no
value: a sender observes the effect in the room's facts. An event is appended in
the room's space, so sending needs write access there, and the room acts on it
later, possibly in another runtime.

Each stream below is written as a call, with its event's keys as the parameters:
`sendReaction(requestId: string, message: Cell<ChatMessage>, emoji: string)`
sends `{ requestId, message, emoji }`.

No event names its sender. The room learns who sent it from the event's actor:
the principal the memory server stamps on the appended event from its
authenticated commit, beside the payload rather than in it (`firedAt.user`, see
[events](../server-side-execution/events.md)), or, for a handler that runs in
the sender's own runtime, that runtime's user. Below, **the sender** is that
principal, and **the sender's profile** is the profile
`wish({ query: "#profile" })` resolves to for it (see [per-demanding-identity
wish resolution](../server-side-execution/builtins.md)): the sender's default
profile, or their most recently used one. The sender can't choose which, and
when it resolves to none, as when they have several profiles and no default, the
event is refused.

These rules hold for every stream:

- Every event carries a `requestId`, which the sender chooses, unique among its
  requests, such as a random 128-bit value. The room acts on a given sender's
  `requestId` at most once: an event whose sender and `requestId` it has already
  acted on changes nothing. That protects against the same event taking effect
  twice, as when a served handler runs an event again because its first run's
  completion wasn't recorded. (A client runtime's own re-submission of an event
  is ignored when it arrives, by its event id.) A client doesn't send an event
  again itself: a trusted gesture can't be re-issued from a client's code (see
  [`clients.md`](clients.md#writing-the-reviewed-gesture-requirement)), and a
  person who tries again makes a new request.
- The room remembers a `requestId` for at least `proposedTimeMaxAgeNsec` plus
  `proposedTimeMaxLeadNsec`, and at least `recentActivityWindowNsec`, measured
  from when it recorded the request. By then a repeated `sendMessage` or
  `editMessage` is refused anyway, since its proposal is outside the window. For
  other streams, a repeat later than that could undo a later request, such as a
  reaction removed and then restored. So a room relies on its runtime finishing
  or dropping every event well within that time (see
  [`FabriChatRoom`](FabriChatRoom.md#prerequisites)).

- A stream that names a reviewed surface admits an event only as a trusted
  gesture on that surface (see
  [`clients.md`](clients.md#writing-the-reviewed-gesture-requirement)), and the
  record it writes is labeled `authored-by` the principal who sent it.
- `sendMessage`, `editMessage`, and `sendReaction` record the sender's profile,
  and refuse an event that arrives before it resolves. The
  other streams don't depend on a profile.
- Writing in a room is joining it. When `sendMessage` appends a message,
  `sendReaction` adds a reaction, or `setTitle` sets the title, in a room in a
  space of its own, the room
  sends the sender's manager's
  [`joinRoom`](ChatManagerOutput.md#joinroomrequestid-string-room-cellchatroomoutput),
  so a room the sender reached by its link, or forgot, becomes one of their
  chats. The manager checks membership in its own Home-space event and leaves
  an already saved room unchanged. The room reads no private catalog and sends
  nothing for a sender with no manager. It sends `joinRoom` in an event of its
  own, once the write has landed, so the write reads nothing of the manager. A
  manager in a person's Home can carry a confidentiality label, such as their
  `PersonalSpace`, that the room's space doesn't admit, and anything the room
  stores that read it would be refused. So what the room stores about joining
  says only whether the room is one a manager can take the sender into, and
  only the join's own event, which writes nothing in the room's space, reads
  whether the sender has a manager: such a manager is still told of the join.
- A refusal writes nothing to the room's shared record. The sender's outcome
  is recorded where only they read it: in `messageRequests` for a message
  act, in `addRequests` for an add, and in `titleRequests` for a retitle, each
  `refused` with a reason and a code. The room's own composer shows the
  session's latest refusal until an act takes effect. A refused `openWindow` or
  `closeWindow` records no outcome. A client still checks an event against the
  stream's rules before sending it (see
  [`clients.md`](clients.md#writing-the-reviewed-gesture-requirement)).
- A refused event is spent: it is not retried.

| Stream | Reviewed surface | Effect |
| --- | --- | --- |
| [`sendMessage`](#sendmessagerequestid-string-version-chatmessageversion-replyto-chatreply) | `ChatSendSurface` | appends a message from the sender, once |
| [`editMessage`](#editmessagerequestid-string-message-cellchatmessage-version-chatmessageversion) | `ChatEditSurface` | records a new version of the sender's message, once |
| [`deleteMessage`](#deletemessagerequestid-string-message-cellchatmessage) | `ChatDeleteSurface` | records the sender's message as deleted |
| [`obliterateMessage`](#obliteratemessagerequestid-string-message-cellchatmessage) | `ChatObliterateSurface` | removes a message and its history, leaving a tombstone |
| [`sendReaction`](#sendreactionrequestid-string-message-cellchatmessage-emoji-string) | `ChatReactSurface` | adds the sender's reaction, if it isn't there |
| [`deleteReaction`](#deletereactionrequestid-string-message-cellchatmessage-emoji-string) | `ChatReactSurface` | removes the sender's reaction, if it's there |

### `sendMessage(requestId: string, version: ChatMessageVersion, replyTo?: ChatReply)`

- `requestId: string` — Chosen by the sender, and unique among its requests. The
  room acts on a request at most once (see [streams](#streams)).
- `version: ChatMessageVersion` — The message to send, as a
  [`ChatMessageVersion`](ChatMessageVersion.md):
  - `version.body` is the message's text, exactly as the person saw it when they
    sent it. It must be a string, not empty or only whitespace.
  - `version.sentAt` is the time the sender's client proposes for the message,
    chosen once when the person sends it. It is a hint to the room about when
    the message was sent, not an identifier: two sends can propose the same
    time.
- `replyTo?: ChatReply` — What the message replies to, and where it is shown
  (see [`ChatReply`](ChatReply.md)). Absent for a message that isn't a reply,
  which is shown in the main conversation. `replyTo.message` must be a message
  in this room, and a `"main"` reply must be to a message the main conversation
  shows.

Sends a message from the sender.

- **Admitted:** as a trusted gesture on `ChatSendSurface`.
- **Effect:** appends a [`ChatMessage`](ChatMessage.md) to the room's messages,
  with the sender's profile as `authorProfile`, `version.body` as `body`, no
  `earlierVersions`, and no reactions. Its `sentAt` is chosen as [recorded
  times](#recorded-times) describes. A reply's is then raised, if need be, to
  later than its target's `sentAt`, so a reply never sorts before the message it
  replies to. Last, it is made unique as [unique
  times](ChatMessage.md#unique-times) states.
- **Refused:** a `version.body` that isn't a non-empty string, a
  `version.sentAt` outside the room's window (see [recorded
  times](#recorded-times)), a `replyTo` whose `message` is in another room, a
  `shownIn` other than `"main"`, `"thread"`, or `"both"`, a `"main"` reply to a
  message shown only in a thread, or a reply to a deleted message.

Two messages with the same text are two sends with two request ids, so sending
"YES!" three times makes three messages, whatever times they propose.

#### Recorded times

A room decides the time it records for a send (`sentAt`) or an edit (`editedAt`)
from the sender's proposed time and its own handler clock, within a window its
policy states (`proposedTimeMaxAgeNsec` and `proposedTimeMaxLeadNsec`, see
[`ChatRoomPolicy`](ChatRoomPolicy.md)). Every time here is a `FabricEpochNsec`.
The handler clock reads a coarse time in milliseconds, which a room converts by
multiplying by 10⁶, as conversion from a `Date` does.

The handler clock is the time of the event that set the handler running (see the
[timing side-channel mitigations](../sandboxing/TIMING_SIDE_CHANNELS.md)). When
the room's handler runs on the room's side (served execution), that is when the
room took the event, and the window below bounds how far a sender's clock can
place a message. When the handler runs in the sender's own runtime, the handler
clock is the sender's own clock, and the window bounds only a proposal against
that same clock, which is a formality.

The window reaches a different distance on each side of the handler clock,
because a proposal lands on each side for a different reason:

- **Before the clock**, by up to `proposedTimeMaxAgeNsec`. A proposal is older
  than the clock for ordinary reasons: the network's delay, a retry, a client
  that queued the send while offline. So this side can be generous.
- **After the clock**, by up to `proposedTimeMaxLeadNsec`. A proposal is newer
  than the clock only because the sender's clock runs ahead of the room's, so
  this side only needs to cover clock skew, and can be small.

A proposal within the window is recorded as the time, except that a proposal
after the clock is recorded at the current time (see below). The room MAY adjust
the time first, for example to coarsen it to the system's clock resolution. A
proposal outside the window is refused, with `out-of-window` in the sender's
`messageRequests`: it is a very stale retry, a badly wrong clock, or a forgery.

Whatever the proposal, a room MUST NOT record a time later than its own current
time, meaning its handler clock's reading when it makes the record. A proposal
after the clock, within `proposedTimeMaxLeadNsec`, is accepted, but recorded at
a time no later than the current time.

Two things can carry a recorded time past the current time. One is the floor
that keeps a reply later than its target (see
[`sendMessage`](#sendmessagerequestid-string-version-chatmessageversion-replyto-chatreply)),
since the target may have been recorded by a clock ahead of this one. The other
is the steps added to make a time unique (see [unique
times](ChatMessage.md#unique-times)), which never carry it past the end of the
current clock tick. A handler clock reading stands for a whole tick of the
system's clock resolution, so a reading of `t` with a resolution of `r` covers
times from `t` up to, but not including, `t + r`, and a bumped time stays within
that range.

Accepting a sender's time lets a sender place a message earlier than it arrived,
by up to `proposedTimeMaxAgeNsec`, but never later than it arrived. That is the
cost of the window's older side, and why each room states it.

### `editMessage(requestId: string, message: Cell<ChatMessage>, version: ChatMessageVersion)`

- `requestId: string` — Chosen by the sender, and unique among its requests. The
  room acts on a request at most once (see [streams](#streams)).
- `message: Cell<ChatMessage>` — The message to edit. Must be a message in this
  room, sent by the sender, and not deleted.
- `version: ChatMessageVersion` — The new version, as a
  [`ChatMessageVersion`](ChatMessageVersion.md):
  - `version.body` is the new text, exactly as the person saw it when they
    edited it. It must be a string, not empty or only whitespace.
  - `version.sentAt` is the time the sender's client proposes for the edit,
    chosen once when the person makes it. It is a hint to the room, as for
    `sendMessage`.

Records a new version of one of the sender's messages.

- **Admitted:** as a trusted gesture on `ChatEditSurface`, and only from the
  message's sender.
- **Effect:** makes `version.body` the message's current version. Its `editedAt`
  is chosen as [recorded times](#recorded-times) describes, then made unique as
  [unique times](ChatMessage.md#unique-times) states. The version it replaces
  goes to `earlierVersions`, as far as the implementation's history rules keep
  it. `authorProfile`, `sentAt`, `replyTo`, and the reactions don't change.
- **Refused:** a `message` in another room, sent by someone else, or deleted, a
  `version.body` that isn't a non-empty string, or a `version.sentAt` outside
  the room's window.

Two edits with the same text are two edits with two request ids, so they record
two versions.

### `deleteMessage(requestId: string, message: Cell<ChatMessage>)`

- `requestId: string` — Chosen by the sender, and unique among its requests. The
  room acts on a request at most once (see [streams](#streams)).
- `message: Cell<ChatMessage>` — The message to delete. Must be a message in
  this room, sent by the sender, and not already deleted.

Records one of the sender's messages as deleted.

- **Admitted:** as a trusted gesture on `ChatDeleteSurface`, and only from the
  message's sender. No one deletes a message someone else sent, an OWNER
  included, whatever the room's policy.
- **Effect:** depends on whether the implementation makes deletion obliteration
  (see [implementation-defined behavior](#implementation-defined-behavior)):
  - If it does, the message is obliterated, exactly as `obliterateMessage` would
    by its sender: a tombstone labeled with the sender, with no `authorProfile`,
    history, or reactions (see [obliterated
    messages](ChatMessage.md#obliterated-messages)).
  - If it doesn't, the version being deleted goes to `earlierVersions` first, as
    `{ body, sentAt }` with the time it was recorded, where the room's policy
    keeps history (`keepsHistory`). Then the message's `body` becomes exactly
    `{ deleted: true }`, recorded at the handler clock as `editedAt`, made
    unique as [unique times](ChatMessage.md#unique-times) states, and its
    reactions are removed. Its `authorProfile` and history stay, so a room that
    keeps history keeps the deleted text in it.

  Either way, no reaction outlives the deletion, and the message stays among the
  room's messages, so replies to it and threads rooted at it keep their links.
- **Refused:** a `message` in another room, sent by someone else, or already
  deleted.

### `obliterateMessage(requestId: string, message: Cell<ChatMessage>)`

- `requestId: string` — Chosen by the sender, and unique among its requests. The
  room acts on a request at most once (see [streams](#streams)).
- `message: Cell<ChatMessage>` — The message to obliterate. Must be a message in
  this room that the sender may obliterate: anyone's, if the sender is an OWNER
  and the room's policy lets OWNERs obliterate; and in a direct room, also one
  the sender sent.

Removes a message entirely, with its history. Where the room's policy allows
it, it is how an OWNER curates the conversation, in a direct room as in a group
room, and an outward act when it removes someone else's words. In a direct
room, it is also how either person removes their own words completely.

- **Admitted:** as a trusted gesture on `ChatObliterateSurface`: from a member
  the room space's access list makes OWNER, for any message, whoever sent it,
  where the room's `ownersMayObliterate` holds (see [implementation-defined
  behavior](#implementation-defined-behavior)); and in a direct room, also from
  a message's own sender, whatever their access and whatever the policy. Where
  `ownersMayObliterate` doesn't hold, being an OWNER confers nothing here: an
  OWNER obliterates only what anyone else may, and no more deletes someone
  else's message than they could otherwise. A member of a group room who can't
  obliterate takes back their own message completely by deleting it, where the
  implementation makes deletion obliteration.
- **Effect:** reduces the message to a tombstone (see [obliterated
  messages](ChatMessage.md#obliterated-messages)): its `body` becomes
  `{ deleted: true }`, its `editedAt` the handler clock, made unique as [unique
  times](ChatMessage.md#unique-times) states, and its `authorProfile`,
  `earlierVersions`, and `reactions` are removed. `sentAt` and `replyTo` stay.
  The tombstone is labeled `authored-by` the sender, whoever obliterated it.
- **Afterward:** the times the removed versions and reactions were recorded at
  stay used, and a retry of the original send doesn't send the message again:
  the room still remembers the send's `requestId`, for as long as it remembers
  any.
- **Refused:** a `message` in another room; and, unless the room is a direct
  room and the message is the sender's own, a sender who isn't an OWNER, or any
  sender where the room's `ownersMayObliterate` doesn't hold. Obliterating a
  message that is already obliterated changes nothing.

### `sendReaction(requestId: string, message: Cell<ChatMessage>, emoji: string)`

- `requestId: string` — Chosen by the sender, and unique among its requests. The
  room acts on a request at most once (see [streams](#streams)).
- `message: Cell<ChatMessage>` — The message reacted to. Must be a message in
  this room.
- `emoji: string` — A single emoji: exactly one emoji sequence that [Unicode
  Technical Standard #51](https://www.unicode.org/reports/tr51/) recommends for
  general interchange (`RGI_Emoji`). It may be more than one code point, as with
  a skin-tone modifier or a ZWJ-joined sequence, but it is one emoji. Not text,
  and not two emoji together.

Adds the sender's reaction to a message.

- **Admitted:** as a trusted gesture on `ChatReactSurface`.
- **Effect:** if the sender has no reaction with `emoji` on `message`, adds a
  [`ChatReaction`](ChatReaction.md) to that message's `reactions`, recorded at
  the handler clock as its `sentAt`, made unique as [unique
  times](ChatMessage.md#unique-times) states. If they already have one, nothing
  changes, and it keeps its `sentAt`. No one else's reaction changes, and
  neither does the message itself.
- **Refused:** a `message` in another room or deleted, or an `emoji` that isn't
  a single emoji.

Adding a reaction that's already there changes nothing, even under a new
`requestId`, and so does removing one that isn't.

### `deleteReaction(requestId: string, message: Cell<ChatMessage>, emoji: string)`

- `requestId: string` — Chosen by the sender, and unique among its requests. The
  room acts on a request at most once (see [streams](#streams)).
- `message: Cell<ChatMessage>` — The message whose reaction to remove. Must be a
  message in this room.
- `emoji: string` — A single emoji: exactly one emoji sequence that [Unicode
  Technical Standard #51](https://www.unicode.org/reports/tr51/) recommends for
  general interchange (`RGI_Emoji`). It may be more than one code point, as with
  a skin-tone modifier or a ZWJ-joined sequence, but it is one emoji. Not text,
  and not two emoji together.

Removes the sender's reaction to a message.

- **Admitted:** as a trusted gesture on `ChatReactSurface`.
- **Effect:** if the sender has a reaction with `emoji` on `message`, removes
  it. If they don't, nothing changes. No one else's reaction changes, and
  neither does the message itself.
- **Refused:** a `message` in another room or deleted, or an `emoji` that isn't
  a single emoji.

A client never toggles: it sends whichever of the two the person asked for, so a
repeated or delayed event can't undo what the person meant.

<a id="addmemberrequestid-string-target--value-string--profile-cellchatprofile"></a>

### `addMember(requestId: string, target?: { value?: string, name?: Cell<ChatProfile> }, profile?: Cell<ChatProfile>)`

- `requestId: string` — Chosen by the sender, and unique among its adds. The
  outcome is recorded under it in `addRequests`, and sending the same event
  again with it changes nothing. The rendered add control's click carries none,
  and is given one of its own.
- `target.value?: string` — The chat address of the person to admit: a
  principal's DID, as the room's add control holds it.
- `target.name?: Cell<ChatProfile>` — The picked person's public profile, bound
  to the button's native `name`. Its attested principal names whom to admit.
- `profile?: Cell<ChatProfile>` — The person's profile, whose
  `represents-principal` label names them, as the reader's manager lists it in
  its `people`. Given with `target.value`, the two must name the same person;
  given alone, the label names whom to admit. Takes precedence over
  `target.name` when both are supplied.

Admits someone to a room's space, and has the reader's chat manager
([`ChatManagerOutput`](ChatManagerOutput.md)) tell them of the room. Unlike the
streams in the table, it takes a gesture of its own, and it is in `[VIEWS]`
with them.

- **Admitted:** as a trusted gesture on `ChatAddMemberSurface`, from the room's
  rendered add control, which takes an address or a pick from the people the
  reader's manager lists who aren't in the room yet, or from a client's own
  control through the sanctioned issuing path (see
  [`clients.md`](clients.md#the-sanctioned-issuing-path)), from an OWNER of the
  room's space, for a group room in a space of its own.
- **Effect:** grants the principal OWNER on the room's space, so they too may
  add others. Granting someone the OWNER they already hold changes nothing.
  Then, in an event of its own, so that the add reads nothing of the manager,
  for the reason a write that joins a room doesn't (see the rules every stream
  holds to), for a reader with a manager the room sends the manager's
  [`offerRoom`](ChatManagerOutput.md#offerroomrequestid-string-room-cellchatroomoutput-member-string-profile-cellchatprofile),
  naming the person and the `profile` when the add has one, under a
  `requestId` composed of the room's space and the add's own. The manager
  offers them the room through their profile's share inbox, or, given only
  their address, through the profiles its `people` lists for them, and
  otherwise produces a notice for them. An add with no manager to send to,
  because the reader has none or theirs hasn't resolved yet, tells the person
  nothing more.
- **Refused:** a direct room, whose space keeps its two members; an address
  that is not a principal's DID, a `profile` that attests no principal or
  names someone other than `target.value`, a sender without OWNER, a room that
  shares an existing space, and anything the space's access list refuses. The
  rendering tells the session what came of its add, and how the person was
  told of the room once that is decided, and shows a direct room no add
  control.
- **Outcome:** recorded in `addRequests`: `done`, or `refused` with a `reason`
  for a person to read. A direct room's refusal also carries the `code`
  `direct-room`, which stays the same whatever the `reason` says; the others
  carry none. An add the stream doesn't admit, as one without the gesture,
  records nothing.
- **Delivery:** a `done` add carries `delivery`, how the person was told of
  the room: `offered`, sent to at least one share inbox, which says nothing of
  whether it arrived; `noticed`, a notice in the manager's `outgoingNotices`
  for a client to deliver; or `access-only`, told nothing, so that the adder
  has to send them the room's link. An add with no manager to send to records
  `access-only` in that event: the reader has no manager, or theirs hasn't
  resolved yet. Nothing is ever offered for such an add, even once a manager
  resolves, since nothing runs then to send it. Otherwise
  `delivery` is the manager's verdict, which `addRequests` reads from the
  manager's `requests` once it is recorded, and is absent until then. A
  manager that refuses to tell anyone of the room, as it does for a room its
  catalog doesn't list, makes it `access-only`, with the manager's `reason` as
  `deliveryRefusal`. The manager records a verdict for every `offerRoom` it
  receives, so every add that is done gets a `delivery` eventually, either at
  once or when the verdict lands, and an absent one always means the verdict
  is still coming.

The people picker and delivery projection run in the viewer's Home space,
where private manager data may be read and stored. The room retains the
admission command and the session's latest-add reference. The Home display
binds its buttons directly to admission and carries the canonical public
profile as `target.name`, so admission reads no private candidate list.
Only cell references to the personal rendering and outcomes return to the
room. The rendering and click feedback belong to the session; invitation
verdicts belong to the viewer across sessions.

### `addParticipant(profile: Cell<ChatProfile>)`

- `profile: Cell<ChatProfile>` — A person's profile, as the live cell in its
  own space.

Adds a profile to those who joined the room: for a room in a space of its own,
the participants it keeps for its space. Unlike the streams in the table, it
takes no `requestId`: a profile already listed is not added again, so a repeat
changes nothing. Like them, and like `addMember`, it is in `[VIEWS]`. Any
participant may add any profile, so an entry is a claim. A member's chat
manager adds its user when it creates or accepts the room.

- **Admitted:** without a reviewed gesture.
- **Effect:** adds the profile to the room's participants, unless it is listed
  already. The profile's document must carry a label, as a profile does; one
  that carries none is refused.

### `setTitle(requestId: string, title: string)`

- `requestId: string` — Chosen by the sender, and unique among its retitles.
  The outcome is recorded under it in `titleRequests`, and sending the same
  event again with it changes nothing. The rendered retitle control's click
  carries none, and is given one of its own.
- `title: string` — The new title, exactly as the person saw it when they set
  it. It must have some text in it: a string, not empty or only whitespace.

Sets the room's title, which every member shares: the `title` the room's
`about` shows (see [`ChatRoomAbout`](ChatRoomAbout.md)), and the name a
manager's list shows it by, read through the room's link (see
[`ChatIndexEntry`](ChatIndexEntry.md#fields)). Like `addMember`, it takes a
gesture of its own, records its outcome, and is in `[VIEWS]`.

- **Admitted:** as a trusted gesture on `ChatRetitleSurface`, from the room's
  rendered retitle control, or from a client's own control through the
  sanctioned issuing path (see
  [`clients.md`](clients.md#the-sanctioned-issuing-path)), from any member who
  can write in the room, in a group room or a direct one.
- **Effect:** records the title, trimmed of the whitespace around it, labeled
  `authored-by` the sender, as the title a member last set. It replaces any
  title set before, and outranks the one the room was created with, which
  `about.record` keeps. Nothing else about the room changes, and nothing is
  added to `recentActivity`, which logs messages and reactions: a client
  follows the title by reading `about.title`. Then, as a write in the room
  does, it sends the sender's manager's `joinRoom`, in an event of its own,
  and the manager brings the title its catalog lists the room under up to the
  new one (see
  [`joinRoom`](ChatManagerOutput.md#joinroomrequestid-string-room-cellchatroomoutput)).
- **Refused:** a sender who can't write in the room, or isn't signed in
  (`not-member`); a `title` with no text in it (`invalid-title`); and a room
  that shares an existing space, a space's own chat, which is shown by its
  space's name (`fixed-title`).
- **Outcome:** recorded in `titleRequests`: `done`, or `refused` with a
  `reason` for a person to read and a `code` a client acts on, which stays the
  same whatever the `reason` says. A refusal changes nothing else. A retitle the
  stream doesn't admit, as one without the gesture, records nothing.

## Renderings

- **`[UI]`** is the room's own rendering, with its reviewed surfaces. An
  adapter's rendering embeds it, so a composer is always the room's own surface.
- **`[VIEWS]`** holds a `room` group with the facts and streams above, for hosts
  that draw natively. It includes `messages`, through whose link a client
  reaches its own windows and their streams, `openWindow` and `closeWindow`,
  the same streams at the group's top level, `canSend`, `viewer`,
  `messageRights`, `messageRequests`, `addMember` with `canAdd` and
  `addRequests`, and `setTitle` with `titleRequests`. A client uses it to show
  a room outside any container. Inside a container, it reads the placement's
  `chat` group instead
  ([`FabriChatPlacement.md`](FabriChatPlacement.md#outputs)).

## Implementation-defined behavior

This contract leaves some of what a room allows to its implementation, because
rooms legitimately differ. A room where people share personal details may let
anyone take back what they said, while a room under a strict retention
requirement may be legally required to keep everything. The contract doesn't fix
these, and an implementation MUST state its choice for each in its rooms'
`about.policy`:

- **Deletion as obliteration.** Whether a sender deleting their own message
  obliterates it, which is how a member of a group room takes back what they
  said completely.
- **Obliteration by OWNERs.** Whether an OWNER may obliterate messages,
  anyone's (`ownersMayObliterate`), in a direct room as in a group room.
- **What an edit keeps** in a message's history.
- **The limits on message windows**: how many messages a window holds
  (`maxWindowCount`), and how many a session can have open (`maxOpenWindows`).
- **The window of accepted proposed times**, on each side of the clock (see
  [recorded times](#recorded-times)).
- **How long recent activity lasts** in `recentActivity`, at least as long as
  the window's older side.

An implementation may make these configurable, per room or otherwise, and how it
does so is its own business (see
[`FabriChatRoom`](FabriChatRoom.md#configuration)).

`about.policy` links a [`ChatRoomPolicy`](ChatRoomPolicy.md), and an
implementation MUST state it correctly: a client reads a room's choices there,
and can rely on them. Two things are not choices: no one deletes a message
someone else sent, and a direct room MUST let either person obliterate their
own messages.

## Open questions

- **Membership's open questions belong to the space.** Returning after leaving,
  and being added without consent, are questions about a space's access list
  and its tools, and a room changes neither.
