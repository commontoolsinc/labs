# Glossary

## ACL (Access Control List)

Defines who can read or write specific data in a space, forming part of the
data's access policy.

## Cell

Cell is a unit of reactivity, conceptually it is similar to a cell in a
spreadsheet. It holds a value that can be updated by writing into a cell. Cell
can also have subscribers that will be called whenever cell content is updated
allowing them to compute derived state which will end up propgating it to some
output cell.

## CFC (Contextual Flow Control)

A security model combining information flow control with contextual integrity;
enforces policies on how data is used, attached to schemas and validated both
statically and dynamically.

## Charm

Charm is a [spell] invocation binding set of [cell]s as inputs and set of
[cell]s as outputs, creating an execution graph. It may help to think of [spell]
as an open electric circuit, in this case [charm] would be a closed electric
circuit as current will flow through it. Different analogy could be to think of
[charm] as a process, where's [spell] would be a program and [cell]s would be
program inputs and outputs.

## CRDT (Conflict-free Replicated Data Type)

A data structure that can resolve conflicts automatically in distributed
systems. Used selectively, e.g. for collaborative text editing.

## Space

Space is primarily a sharing boundary, designed to enforce access control.
Spaces are identified by unique [did:key] identifiers.

> ℹ️ Currently each space has a corresponding sqlite database to store all of
> its state.

Space can be queried and updated using [memory protocol], which describes state
in terms of [fact](#fact)s.

## Fact

Is a record of state in time represented using `{ the, of, is, cause }` tuples.
E.g consider following fact: _The_ **color** _of_ **sky** _is_ **blue** it would
directly translated to `{ the: "color", of: "object:sky", is: "blue" }`.

> ℹ️ The `cause` filed is used to establis causal references, it effectively
> represents a logical time per fact as opposed to global time.

In practice we use `the` field to describe kind of the information value (`is`
field) is provided about subject entity (`of` field). Predominantly `the` is
`"application/json"` as we store [cell] contents as JSON values and consequently
`is` field is a JSON value [cell]s hold at discrete points in time.

The `of` field is a unique identifier represented via URI. In practice it
usually a [merkle-reference] derived from some seed data with `of:` scheme
prefix.

## Memory

Memory is an abstraction over [space] and an information system adhering to
[The Value of Values] design principles. Abstraction provides efficient way to
access current state - current facts about various entities, while still
providing a way to recall facts that had being succeeded by the new ones.

Memory also provides interface for accreting new information through an
interface with [compare and swap (CAS)][CAS] semantics.

> ℹ️ Please note that layers above [memory] do not follow same principals or
> operate at the level of [fact]s, instead they use more traditional
> document-oriented semantics and reference state by the address inside the
> mutable memory space.

## [did:key]

A decentralized identifier derived from a keypair. Used to uniquely identify and
control a [Space].

## Event Handler

Code that reacts to events and may update other cells or trigger further
actions.

## LLM (Large Language Model)

AI models such as Claude or ChatGPT that can be called from recipes for
AI-generated outputs.

## Reactive Framework

The runtime engine behind Open Ocean that computes state updates in a
deterministic way, using dependency graphs of reactive cells.

## Recipe

A function that defines a reactive graph. Can produce UI, derived data, or
streams. Used like components in other reactive frameworks.

## CTS (Common TypeScript)

Typescript dialect that is pre-processed in recipes to preserve familiar
Typescript patterns when using Cells and shared storage. This leverages the
typescript compiler to parse the AST (Abstract Syntax Tree) of the code, and
make appropriate transformations.

## Safe Rendering

The secure, isolated rendering of recipe-generated UI, considered part of the
Trusted Computing Base (TCB).

## Space

A namespace for user data, identified by a [did:key]. Users control access and
permissions via [UCAN]s and ACLs.

## Spell

Unit of computation that describes transformation from the set of inputs to the
set of outputs. In practice it is manifested as a typescript function that takes
an object with set of properties and returns an object with a set of outputs.

It is worth pointing out that while typescript function is used it does not
actually defines a computation, instead it is a way to build a computation
pipeline that flows through input [cell]s into output [cell]s.

## Storage - Cache (IndexDB)

The persistent storage layer using IndexedDB (when
available) that survives across browser sessions and stores historical revisions
fetched from the remote server. The cache is only accessed during load()
operations when explicitly loading data into the heap at session start or when
accessing new entities. Writes to the cache occur as a write-through persistence
layer: after successful pulls from remote, when receiving subscription updates,
or during load operations. The cache never stores data directly from local
changes. If IndexedDB is unavailable, it falls back to NoCache which provides no
persistence. This tier aims to improve startup performance.

> Note: While IndexedDB provides the storage layer, queries are currently
> performed through schema queries rather than direct IndexedDB queries. Direct
> IndexedDB query functionality would require additional development to be useful.

## Storage - Heap

The in-memory cache for the current session that stores confirmed revisions
from the remote server. All incoming subscription data and remote updates flow
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
succeeds, facts are promoted from nursery to heap. If a commit fails, facts
are deleted from the nursery to prevent building on rejected state. The nursery
"shadows" the heap, meaning reads check here first, and any local unconfirmed
change will be returned even if the heap has a newer version from the server.

Nursery eviction occurs in several scenarios:
- When the remote server returns a matching state, indicating the server has
  caught up with the local change
- When conflicts occur, which will purge conflicting entries from the nursery
- When an update arrives that matches what was expected from the server, but
  local changes have been built on top of those changes (in this case, the
  nursery copy is retained to preserve the local changes)

## TCB (Trusted Computing Base)

The minimal set of components that must be trusted to enforce security. This
includes rendering infrastructure (e.g. web components), and excludes
user-authored recipes, which are sandboxed.

## UCAN (User Controlled Authorization Network)

A capability-based auth system that allows delegating access rights using signed
tokens.

## VDOM (Virtual DOM)

A data representation of UI elements returned by recipes, which the runtime
turns into rendered HTML.

[spell]: #spell
[cell]: #cell
[charm]: #charm
[acl]: #acl-access-control-list
[cfc]: #cfc-contextual-flow-control
[cts]: #cts-common-typescript
[crdt]: #crdt-conflict-free-replicated-data-type
[deno]: #deno
[did:key]: #didkey
[event-handler]: #event-handler
[llm]: #llm-large-language-model
[memory]: #memory
[reactive-framework]: #reactive-framework
[recipe]: #recipe
[safe-rendering]: #safe-rendering
[space]: #space
[tcb]: #tcb-trusted-computing-base
[ucan]: #ucan-user-controlled-authorization-network
[vdom]: #vdom-virtual-dom
[memory protocol]: https://github.com/commontoolsinc/RFC/blob/main/rfc/memory.md
[The Value of Values]: https://www.youtube.com/watch?v=-I-VpPMzG7c
[merkle-reference]: https://github.com/Gozala/merkle-reference/blob/main/docs/spec.md
[CAS]: https://en.wikipedia.org/wiki/Compare-and-swap
[did:key]: https://w3c-ccg.github.io/did-key-spec
