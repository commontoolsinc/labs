# Runtime Glossary

Storage and memory internals of the Common Fabric runtime. Pattern authors
rarely need these terms — for author-facing concepts see the
[main glossary](../common/concepts/glossary.md).

## Fact

Is a record of state in time represented using `{ the, of, is, cause }` tuples.
E.g. consider the following fact: _The_ **color** _of_ **sky** _is_ **blue** —
it would be directly translated to
`{ the: "color", of: "object:sky", is: "blue" }`.

> ℹ️ The `cause` field is used to establish causal references; it effectively
> represents a logical time per fact as opposed to global time.

In practice we use `the` field to describe kind of the information value (`is`
field) is provided about subject entity (`of` field). Predominantly `the` is
`"application/json"` as we store [cell] contents as JSON values and consequently
`is` field is a JSON value [cell]s hold at discrete points in time.

The `of` field is a unique identifier represented via URI. In practice it
usually a hash derived from some seed data with `of:` scheme prefix.

## Memory

Memory is an abstraction over [space] and an information system adhering to
[The Value of Values] design principles. Abstraction provides efficient way to
access current state - current facts about various entities, while still
providing a way to recall facts that had being succeeded by the new ones.

Memory also provides interface for accreting new information through an
interface with [compare and swap (CAS)][CAS] semantics.

> ℹ️ Please note that layers above [memory] do not follow the same principles
> or operate at the level of [fact]s, instead they use more traditional
> document-oriented semantics and reference state by the address inside the
> mutable memory space.

## Storage - Cache (IndexDB)

The persistent storage layer using IndexedDB (when available) that survives
across browser sessions and stores historical revisions fetched from the remote
server. The cache is only accessed during load() operations when explicitly
loading data into the heap at session start or when accessing new entities.
Writes to the cache occur as a write-through persistence layer: after successful
pulls from remote, when receiving subscription updates, or during load
operations. The cache never stores data directly from local changes. If
IndexedDB is unavailable, it falls back to NoCache which provides no
persistence. This tier aims to improve startup performance.

> Note: While IndexedDB provides the storage layer, queries are currently
> performed through schema queries rather than direct IndexedDB queries. Direct
> IndexedDB query functionality would require additional development to be
> useful.

## Storage - Heap

The in-memory cache for the current session that stores confirmed revisions from
the remote server. All incoming subscription data and remote updates flow
directly into the heap (does not touch nursery). The heap maintains subscribers
to notify them when facts change. Facts enter the heap through three paths:
promotion from the nursery after successful commits, direct insertion when
pulling data from remote, or from subscription updates. During reads, the heap
is checked after the nursery. Unlike the nursery which only holds local changes,
the heap represents the authoritative state as known by the server. The heap
persists for the entire session.

## Storage - Nursery

A temporary cache layer that stores only locally-initiated changes before
they're confirmed by the remote server. This enables optimistic updates - when
you make a local change, it immediately goes into the nursery so the UI can
reflect changes instantly without waiting for server confirmation. The nursery
never stores incoming subscription data from the remote server. If a commit
succeeds, facts are promoted from nursery to heap. If a commit fails, facts are
deleted from the nursery to prevent building on rejected state. The nursery
"shadows" the heap, meaning reads check here first, and any local unconfirmed
change will be returned even if the heap has a newer version from the server.

Nursery eviction occurs in several scenarios:

- When the remote server returns a matching state, indicating the server has
  caught up with the local change
- When conflicts occur, which will purge conflicting entries from the nursery
- When an update arrives that matches what was expected from the server, but
  local changes have been built on top of those changes (in this case, the
  nursery copy is retained to preserve the local changes)

[cell]: ../common/concepts/glossary.md#cell
[space]: ../common/concepts/glossary.md#space
[fact]: #fact
[memory]: #memory
[The Value of Values]: https://www.youtube.com/watch?v=-I-VpPMzG7c
[CAS]: https://en.wikipedia.org/wiki/Compare-and-swap
