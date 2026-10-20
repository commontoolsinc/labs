# Document release

A runtime holds a stored document because its memory session watches it. A
watch names a root document and a selector (a path and a schema); the server
keeps the session up to date with the root and with every document the schema
reaches from it through links. The union of a session's watches is what the
runtime's replica of the space holds. This document describes how the runtime
removes the watches nothing needs any more, and drops the documents they kept
loaded, so that a long-lived runtime that opens and closes many pieces does not
hold every document it ever loaded.

The implementation is `SpaceReplica.releaseUnread()` in
`packages/runner/src/storage/v2.ts`, driven by
`Runtime.releaseUnreadDocuments()` in `packages/runner/src/runtime.ts`. The wire
message it relies on is `session.watch.remove`, section 4.3.9 of
[`../specs/memory-v2/04-protocol.md`](../specs/memory-v2/04-protocol.md).

## What keeps a document

A replica keeps a document while any of these holds:

- An action registered with the scheduler read it on its last run. This covers
  a piece's computations, and a cell's `sink()`, which is how a host's
  subscription to a piece's result reads it. The scheduler answers with
  `Scheduler.readsEntity()`, from the same index that decides which actions a
  change wakes.
- A cell whose own document it is has loaded it and is still reachable. A cell
  takes the document's hold token (`IStorageManager.holdDocument()`) when it
  loads, or, for a cell made from a loaded one, when it is first read; the
  storage manager keeps the token only weakly, so the hold ends when every cell
  holding it has been garbage collected. Code that keeps a cell and reads or
  writes its document through it later therefore finds the document still
  loaded. The hold covers that document alone: a document the cell's value
  links to is kept only on its own account, and a read through the link that
  finds it dropped loads it again, as a read of any document not loaded
  does.
- A sink registered on the replica itself (`SpaceReplica.sinkDocument()`) names
  it.
- A local write to it is still pending.

A release pass also keeps the watches rooted at a document that was loaded, or
read through the replica, since the previous pass began. A value read lazily,
such as one `Cell.pull()` returns, can follow a link into a document after the
read that produced it, and this keeps such a document through the pass that
comes next.

An event handler is not a reader between events. Before a handler runs, the
scheduler loads its inputs and waits for them (the presync and the preflight in
`packages/runner/src/scheduler/events.ts`), so a handler whose inputs were
released loads them again when its next event arrives.

## When documents are released

A release pass runs when something that read documents has gone: when a piece
is stopped (`Runner.stop()`, which also runs when the runtime restarts a
piece), and when a host's client departs
(`RuntimeProcessor.disposeClient()` in `packages/runtime-client`). A host may
also call `Runtime.releaseUnreadDocuments()` itself. The pass waits until the
scheduler is idle. Passes run one after another, never two at once.

A pass first gives each document the replica keeps, as above, a watch of its
own where it has none, with a selector that follows no links: a document that
something reads only through a link from another document is otherwise watched
only as part of that document's watch. It then removes the watches rooted at
each document the replica does not keep and that was neither loaded nor read
since the previous pass began, so no removal can take a kept document from the
session. The server answers with `removes` naming each document no remaining
watch reaches. Each is emptied as any removal empties it, and then dropped
unless a local write to it is pending: its value, its delivery record, and its
watched mark go. A document that something began to hold while the removal was
on its way is the exception: it keeps its value and is watched again on its
own, and the answer to that watch brings it up to date. If that watch fails,
the document is removed and dropped like the others, so that its readers load
it again. A removal the server sends for any other reason, such as the
retraction of an instance whose lease has lapsed, empties the document in the
same way, whatever holds it.

The server records which documents a session's watches reach, not which watch
reached each one, so it answers the removal of a watch it walked by walking the
remaining watches of that watch's branch again. Two things keep that short of
watching the space from scratch: a branch the removal names no watch of keeps
its graph, and a watch that was never walked, because the graph of its branch
already covered every root of it when it was added, costs nothing to remove.
The server records those covered watches. A watch is covered by the graph as
a whole, which several walked watches may contribute to, so when a walked
watch is removed the server checks each covered watch of the branch against
the rebuilt graph: one still covered stays unwalked, and one no longer covered
is walked into the rebuilt graph, so the documents it names stay delivered.

A server that does not advertise `watchRemoveV1` could only be asked to remove
a watch by replacing the whole watch set, which sends the whole union back.
Against such a server the runtime keeps every watch.

## Reading a released document again

A dropped document is absent from the replica, as a document the runtime never
loaded is, and the paths that load an absent document load it again, as it now
stands on the server:

- A cell remembers that it loaded its document only until the storage manager
  drops that document (`IStorageManager.droppedDocuments()`), so its next read
  starts a load.
- The storage manager and the runtime forget that they kicked a load for a
  dropped link target or cross-space link (`#docPullKicks`, `#crossingKicks`,
  `Runtime.#missingDocLoadKicks`), and that they pulled the targets of an
  immutable document, so the next read through such a link kicks the load
  again.

## Measuring

`getLoggerCounts().sizes.storage` reports a runtime's `documents` and
`watchedDocuments`, in total and per space under `bySpace`.
`packages/runner/test/document-release.profile.ts` stores forty todo lists and
has a second runtime open each one (load, start, subscribe to its result) and
close it again (cancel the subscription, stop it, let go of its cells),
printing those sizes as it goes; `--no-release` runs it against a server
without watch removal, for comparison.
