# A FabriChat message row as a view over its message

A design spike, written up and not built. It asks what the FabriChat room's
cold load would stop paying if a message row were a view over its message's
cell instead of a nested pattern instance, what the row owns today that only
an instance can own, where each of those things would go, what the runtime
would need, and what the load would then cost. It ends with a recommendation
and the order to build it in.

The numbers are from the thirty-message room's second signed-in load as the
performance records of 2026-10-16 measured it
(`../history/development/performance/2026-10-16-fabrichat-room-cold-load-phases.md`
and the records that followed it), on a worker profile of 12,665 busy
samples with the two schema changes of that evening in place.

## What a row is, and what a load pays for thirty of them

`FabriChatRoomCore` renders its main conversation as
`facts.main.map((message) => <FabriChatMessageRow … />)` and its open thread
as the same map over a per-session list
(`packages/patterns/fabrichat/room.tsx`).
The transformer lowers each map to the `map` builtin with the callback as an
op pattern (`../specs/ts-transformer/ts_transformers_current_behavior_spec.md`
§9.4), so each message is a list child: an instance with a durable result
slot, started by the coordinator inside its own run (`Runner.#startWithTx`),
pre-synced as a family on a resume, and instantiating `FabriChatMessageRow`
inside it.

What one row instance holds (`packages/patterns/fabrichat/message-row.tsx`):

| kind | count | what |
| --- | --- | --- |
| per-session writable | 1 | `pickerOpen` |
| computeds | 16 | `tallies`, `isDeletedNow`, `rights`, `isEditing`, `text`, `isEdited`, `quote`, `replies`, `threadLabel`, `threadLinkDisplay`, and six display strings derived from those |
| actions | 5 | `togglePicker`, `startReply`, `openThread`, `startEdit`, `stopEdit` |
| handler bindings | 11, plus 6 static ones for the quick reactions and 2 per reaction tally | `commitSendReaction` ×3, `commitDeleteReaction` ×2, `commitEdit`, `commitDelete`, `commitObliterate`, `commitReply` ×3 |
| ternaries in JSX | 7 | each an `ifElse` node |
| reactive list | 1 | `tallies.map(…)`, an op instance per tally |

About forty nodes per row, thirty rows, and the thread's rows again while a
thread is open. Against the load's counts:

| per load | measured | the rows' share |
| --- | --- | --- |
| scheduler runs | 1,157 | about 750: 606 derivation runs are the rows' computeds and `ifElse` nodes; the coordinator's child starts are 894 busy samples (`#startWithTx`) |
| commits | 190 | 167 are session-scoped derivation commits, 130 of them `computed:` sets, about four to five per row (`isEditing`, the editor and picker displays, the picker label) |
| commit finalization | 1,028 samples, 86% CFC preparation | one preparation per run, so about 65% of it is the rows' |
| resume pre-sync | about 900 samples; 1,663 list-child syncs and 285 cell syncs | each row is a family of a result slot and some forty owned cells; the participants' twelve chips are the rest |
| render sinks | 3,005 samples, 24% | about 25 bound props per row; not the instance's, the view's |

Together the instances cost about a third of the busy samples, and the
server stores 167 commits a load for them, each carrying its derivation's
three space-scoped reads for validation even when `localSessionDocuments`
empties its operations
(`../history/development/performance/2026-10-16-fabrichat-room-cold-load-local-session-documents.md`).
The first load of a room, which builds the rows, took 36 s against the second
load's 25 s; opening a thread starts five rows the same way.

## What a row owns that only an instance can own

Four things, and the fourth is the one that decides the design.

**Its own session state.** `pickerOpen` is the row's one writable, a
`Writable.perSession(false)`. Everything else that differs by viewer or by
session is derived: `isEditing` compares the room's `composer.editing` to the
message; `rights` reads the viewer's profile and the message's author. The
row writes nothing of its own but the picker.

**Its handlers.** Eleven bindings of the handlers in
`packages/patterns/fabrichat/room-records.tsx`, each a stored node bound to
the message, the room's messages, the viewer's profile, the composer, the
picker and the manager stream. A handler re-runs only on a stale-read
rejection, so the binding is what the instance stores: a stream document and
an argument document per handler per row, pre-synced as owned cells. Every
one of these handlers already takes its message from the event before the
binding, as `(event?.message ?? message)?.resolveAsCell()` in
`commitSendReaction`, and guards it with `isInRoomOf(room, target)`, because
the room's tests send `{ message }` to room-level streams. `RoomStreamEvent`
declares the field.

**Its labels.** Each per-row derivation is a document whose label is minted
at commit from what the run read: the message's document and, for `rights`,
the viewer's profile. That mint is the `prepareCfc` under finalization. The
rendered values reach the page through display sinks, and
`packages/html/src/worker/display-fit.ts` fits each sink's consumed labels
against the render policy (CFC §8.10.6) whether the cell is a row's stored
derivation or the message itself. So the labels a row carries are a cost of
storing derivations, not a capability the view needs: a view binds the
message's cells and the gate reads the message's own label. The per-row
label problem of SQLite result rows (`../specs/sqlite-builtin/06-cfc.md`, the
Phase 3 attachment) does not arise here, because nothing per row is stored.

**Its identity to the reconciler.** The map keys its children by the link of
each element's cell, so a message keeps its DOM across membership changes.
The worker's reconciler keys a reactive children array by a projection of
each node in which a cell stands as its link
(`packages/html/src/worker/keying.ts`), so a row rendered as a view keeps the
same identity as long as its tree binds the message's cells, which it does.

None of the four is something only an instance can own. What the instance
does own is the right to compute: a computed per row runs when that row's
inputs change and no other. That is the trade the rest of this document
prices.

Two things outside the runtime also hold the row's shape today. Eighteen
places in the pattern's tests construct `FabriChatMessageRow({ … })` directly,
and ten test files read its output streams and `tallies`; the room's
contract, `../specs/fabrichat/ChatRoomOutput.md`, does not expose rows, so the
contract is unaffected and the tests are not.

## Where each thing goes

The row's derivations fall into three groups, and each group has a home at
the room, keyed by the message's view key the way `places` already is.

**Shared facts, one record for the room.** `isDeletedNow`, `isEdited`,
`quote`, `replies`, `threadLabel` and `threadLinkDisplay` read the message
alone, or the message and `places`. They join the record `messageFacts()`
already derives in one walk of the messages (`facts.places` is this shape
today), as `facts.rows: Record<key, RowFacts>`. The view binds
`facts.rows.key(key).key("threadLinkDisplay")` where the row today bound its
own computed. The body text stays bound to `message.key("body")` directly,
under `cf-cfc-authorship` as now, so the authorship it shows keeps the
message's own integrity rather than a derived record's; only the deleted
message's stand-in text comes from the record.

**Viewer facts, one record per user and one per session.** `rights` and the
three displays it decides become `rights: PerUser<Record<key, RowRights>>`,
computed once at the room from the viewer's profile and each message's
author. `isEditing` and `editorDisplay` become
`editorDisplay: PerSession<Record<key, ChatDisplay>>`, one run when
`composer.editing` changes instead of thirty. `tallies`, which carries the
viewer's own reaction cell and each reactor's cell, becomes
`tallies: PerUser<Record<key, ReactionTally[]>>`; the view renders
`tallies.key(key)` as cell-valued children, which the reconciler sinks and
re-renders on change (`reconciler.ts`, the `isCell(children)` arm of its
children update).

**The picker, one writable per session.**
`pickerOpen: Writable.perSession<Record<key, boolean>>({})`; the view binds
`pickerOpen.key(key)` to `cf-hover-reveal`'s `revealed`, and the picker's
display and label come from the same cell through a per-session record or,
simpler, from the component: `cf-hover-reveal` already takes the open state
as a prop, and the label can be two static spans shown and hidden by it.

**Handlers, one binding each at the room.** The eleven handlers and five
actions become sixteen room-level bindings that take the message from the
event, which the handlers already do. The actions become handlers of
`{ message }`. The two per-tally handlers take `{ message, emoji }` and
`{ message, reaction }` the same way. This is the one place the view needs
something the runtime does not have today, covered below.

What remains per row is the view: about twenty-five bound props, each a sink.
That is the 24% the sinks cost today, and this design does not touch it.

## What the list primitive needs

Three ways to render thirty views without thirty instances, in rising order
of runtime change.

### A. One computed builds the list of view nodes

A space-scoped `computed(() => facts.main.map((message) => <div>…</div>))`
returning a `VNode[]`. The JSX factory `h()` resolves a cell in a prop to a
link (`packages/runner/src/builder/h.ts`), and the elements of `facts.main`
are cells inside the computed because the list's schema declares them so, so
`message.key("body")` in a prop is a link and not a read. The computed's read
set is then the list's membership and the keys, and it runs when a message
is added, not when one changes. Its result is one document holding thirty
trees, perhaps 300 KB, which a send appends one tree to as a single patch
operation.

Two authoring rules follow, and both are the row's existing discipline. A
ternary inside a computed is plain JavaScript, not an `ifElse`
(`../common/concepts/computed/computed.md`), so the view branches on nothing:
every per-message or per-viewer difference is a display prop bound to a
record's cell beside a static `hidden`, which is how `message-row.tsx` already
shows and hides its controls; the one real branch today, the deleted
message's italic text against the authored body, becomes two elements with
opposite display props. And the computed reads no value: it binds. A `.get()`
on a message inside it would make every message change rebuild the list.

The children of the messages' `cf-vstack` become this computed's cell, which
the reconciler already renders as a cell-valued children array, keyed by the
projection above.

This needs no runtime change for rendering. It needs one for events.

### What A needs: an event prop that carries arguments

A view node's event prop is a stream, and the reconciler registers a handler
per node that sends the browser's event to it (`reconciler.ts`,
`stream.withTx(undefined).send(event)`). Nothing in the node says which
message the click was on. The row today answers that by binding a handler per
row; the view has one stream for all rows and must name the row in the event.

The addition: an event prop may hold a stream together with arguments,
`{ stream, with: { message } }`, which `h()` writes with the arguments
resolved to links as it resolves `$`-props, and the reconciler's registered
handler sends `{ …event, …with }`. It touches `h.ts`, the view-node schema
in `runner`, the reconciler's event-prop arms, and the harness's render of a
view's events in `cf test`. The handlers need no change: `RoomStreamEvent`
already carries `message`, and `isInRoomOf` already refuses a message outside
the room.

The argument is a link the pattern wrote into its own view, so it has the
view's provenance and not the gesture's; the gesture's integrity is minted
from the surface's `data-ui-*` markers as now
(`../specs/ts-transformer/cfc_ui_helper_contract.md`), which are static
attributes a template carries unchanged. A handler that acts on
`event.message` therefore acts on a cell the room chose, under the room's
label, which is what the bound `message` was.

A component can do the same without the runtime: a custom element that puts
a `CellHandle` in its event's `detail` crosses as that cell's link
(`packages/html/src/main/events.ts`). That is the mechanism for a component
that knows its row; the event prop is the mechanism for a pattern that does.
The pattern should not need a component to name its own cells, so the event
prop is the one to build.

### B. A view template the reconciler expands per element

The transformer recognizes a `.map` callback whose body is JSX that only
binds, never computes, and lowers it to a template node:
`{ type: "vnode-list", list, key, template }`, where the template's bindings
are paths off the element. The reconciler expands it per element, binding
`element.key(path)` sinks, and nothing per element exists in the store at all:
no instance, no node, and no list document that grows with the room.

This is the list primitive the question names, and no document under
`docs/features/` describes one; `view-scoped-client-replication.md` is about
which documents a renderer is sent, not how a list is drawn. It would touch
the transformer's eligibility rules (§9.4 and the expression-site policy),
the `VNode` type in `api`, the view-node schema in `runner`, the reconciler,
display fit per expanded element, the harness's view snapshots, and the
`cf test` render. It is the right end state and the wrong first step: it
buys, over A, the 300 KB list document and the computed's run per send, and
it costs a transformer rule whose edge cases are the whole of §9.4's history.

### C. A component that holds the row's logic

A Lit component in `ui` taking `$message`, `$facts` and `$rights` as cells
and deciding the row's display in the browser. It needs neither A's event prop
nor B's template, since a component names its row in its event detail. It
moves the reviewed surfaces' logic out of the pattern and out of `cf test`'s
reach, and puts a chat room's rendering choices in the component layer,
which `cf-profile-badge` already does for a profile but a message row should
not. Not recommended.

## What the load would then pay

Estimated from the measured counts, with A built and the thread's list
rendered the same way:

| per load | today | after | removed |
| --- | --- | --- | --- |
| child starts (`#startWithTx`) | 894 samples | 0; the chips remain, and they were not in this number | 894 |
| scheduler runs | 1,157 | about 400: the room's own, plus the three records' | 750 runs, about 500 samples |
| commits | 190 | about 25: the 167 session derivation commits become one per record | 165 commits |
| commit finalization | 1,028 samples | about 350, in proportion to runs | about 680 |
| resume pre-sync | about 900 samples | about 200: the chips' families and the room's own | about 700 |
| render sinks | 3,005 samples | the same; the records' per-key sinks replace the rows' result sinks one for one | 0 |
| module evaluation | 12% | the same; the row's closure leaves the bundle, the compartment linking of the rest stays | 0 |

About 2,800 of 12,665 busy samples, 22%; up to a third if the rows' share of
the hashing and validation under the removed frames is at the high end,
which the profile cannot separate. The server stops storing 167 commits a
load. The first load of a room stops building rows and should cost what the
second does. Opening a thread starts nothing.

What a send pays after: the records' computeds re-run over the room, as
`messageFacts()` already does, and the list computed appends one tree. What a
reaction or an edit pays after is the change in kind: today it re-runs one
row's `tallies` or `text`; after, it re-runs the room's `tallies` record over
every message's reactions, or `facts` over every body. For thirty messages
that is hundreds of link hops, not thousands. For a room of a thousand it is
every edit walking a thousand messages in three records, where today's rows
pay nothing an edit did not touch. Neither design is incremental; the
instances make a load pay per message and the records make an edit pay per
message. A load happens to every reader every time and an edit to one message
at a time, so the trade favors the records until the room is long enough
that the records' walk is the slow thing, which is also when `messageFacts()`
is, and the fix then is the same for both: a maintained index over the
messages rather than a walk, which `../common/concepts/reactive-collections.md`
describes.

## Trade-offs

- **Labels.** A shared record's stored label is the join of every message it
  read. A message is labeled with its sender (`labels.test.tsx` states the
  rule), so what differs per message is its integrity, and the join of thirty
  senders' integrity is none of theirs: a derived string loses the authorship
  the message has. That is why the body text stays bound to the message and
  the record carries booleans and display strings, which nothing displays as
  anyone's. The confidentiality of a message written into the room's space is
  what that space admits, so the join is readable by whoever reads the room,
  and nothing a viewer sees today is refused. The per-user `rights` record
  reads the viewer's profile and every author, the same as a row's `rights`
  reads its one author, so its label is what each row's was, over the whole
  room.
- **Per-viewer branches.** The rule in `message-row.tsx` stands: a view
  stored once for everyone branches on nothing per viewer, and the list
  computed is space-scoped. Under server execution it runs on the serving
  runtime as the room's other space-scoped derivations do, and the per-user
  and per-session records run where the row's per-session computeds run
  today.
- **Tests.** The eighteen direct constructions of `FabriChatMessageRow` and
  the ten files reading its streams move to the room's streams with
  `{ message }` in the event, which is the form the room's tests already use.
  `room-records.tsx` keeps its handlers unchanged. The room's recorded
  contract moves because the row module leaves its import closure, and
  `deno task pattern-compat --update --only fabrichat/room` re-records it; the
  room's output schema does not change.
- **Deployed rooms.** The old row instances' documents stay in each room's
  space, unread. A room-source deploy re-stages the room's nested instances,
  and the stored-argument validation refuses a `places` entry whose
  `latestReplyAt` holds an epoch envelope where the schema says integer, so
  every row start fails and the update never lands; that defect, recorded in
  the cold-load investigation of 2026-10-16, is fixed before this or any
  room-source deploy.
- **What A does not remove.** The list document and its computed's run per
  send, which B removes, and the sinks, which nothing here touches and which
  are the next third of the load.

## Recommendation

Build it, as A, in this order.

1. The event prop that carries arguments: `h()`, the view-node schema, the
   reconciler's event arms, the harness's render. A runner test that a
   stream prop with `with` sends the merged event; a reconciler test that two
   nodes sharing a stream deliver different arguments.
2. The room: `facts.rows`, the `rights`, `editorDisplay` and `tallies`
   records, the keyed `pickerOpen`, sixteen room-level handler bindings, and
   the list computed for the main conversation and the thread. The row
   pattern and its module go. The eighteen tests move to room streams.
3. Measure on the cold-load rig in the investigation notes, counts first:
   `#startWithTx` 0, scheduler runs about 400, `commitNative` about 25,
   `resumeListChildSync` under 400, `prepareCfc` in proportion; then the
   profile's shares. Record it in `../history/development/performance/`.
4. Decide B on the send measurement alone: if the list document's write or
   the computed's run shows in the thirty-first send's profile, the template
   is the next step; if not, it waits.

Not before the stored-argument refusal is fixed, and not as C.
