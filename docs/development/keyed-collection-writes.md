# Keyed-collection mergeable writes

Status: implemented. This extends the whole-value mergeable ops (append,
add-unique, increment, remove-by-value — see `mergeable-collection-writes.md`) to
the read-then-write patterns those ops do not cover on their own: insert a record
if its key is new, set my per-key value, edit a field of the record with a given
key, delete the record with a given key. The driving example is the lunch poll,
whose handlers are almost entirely keyed mutations of lists of records; it is
migrated to this approach as the worked example.

## The lunch poll's read-then-write inventory

Every mutating handler in `packages/patterns/lunch-poll`, by shape, and the
mergeable form it now uses:

| Handler | Original shape | Mergeable form |
| --- | --- | --- |
| `addOption` | append a new option | set the option entity by id, `addUnique` it |
| `enrichHomePages` | `refresh.set(get() + 1)` | `increment(1)` |
| `addUser` | insert unique by `name` | unchanged — see "The danger with push" |
| `castVote` | upsert by `(voter, option)` with toggle-off | read/edit the vote entity by key; `addUnique` / `removeByValue` |
| `setOptionUrl` / `setOptionImage` / `setOptionHomePageUrl` | edit a field of the option keyed by `id` | edit the field on the option entity addressed by `id` |
| `removeOption` | remove by `id`, then remove its votes | `removeByValue` the option by id; cascade `removeByValue` each vote by its key |
| `clearMyVote` | remove by `(voter, option)` | `removeByValue` the vote by key |
| `resetVotes` | clear all (admin only) | clear each vote entity, then `set([])` — an intentional overwrite |
| `setCity` | scalar register (admin only) | unchanged — `set` is fine |

The bulk are **keyed** mutations of a list of records: insert-if-new, set my
value, edit a record's field, delete a record. Written as read-whole-list,
find-by-a-field, splice/replace-by-position, write-the-whole-list-back, they
false-conflict and clobber under the concurrency a shared multi-user poll has,
and the positional `key(idx)` is fragile: the index is resolved against the
reader's snapshot, so a concurrent insert or remove shifts it and the wrong
record is edited.

## The model: a keyed element is a separately-addressed entity

A list element that is an object becomes its own entity (the array holds a link to
it). The key idea is to make that entity's address **deterministic and
content-only**, derived from a key the handler can compute without reading the
list:

- `arrayCell.elementById(idKey)` returns a cell for the entity derived from the
  array and `idKey`. The derivation is `createRef({ id: idKey }, { parent: <the
  array's entity>, path: <the array's path> })` — it folds in no per-event cause,
  so the same `idKey` resolves to the same entity in any session, at any time.

Given a stable address, the keyed mutations decompose into the whole-value
mergeable ops plus plain entity edits:

- **Insert-if-new** — `set` the entity's content, then `array.addUnique(entity)`.
  `addUnique` dedups by link, so re-adding the same key is a no-op and concurrent
  adds of the same key resolve to one membership entry; adds of different keys
  merge.
- **Set my value** — the same: `set` the entity (last-writer-wins per key), then
  `addUnique` to ensure membership.
- **Edit a field** — `array.elementById(key).key("field").set(value)`. This writes
  the *entity's* document, not the array, so it never touches the list. Two edits
  to different fields of the same record merge (path-scoped conflict detection);
  same field resolves last-writer-wins; edits to different records never interact.
- **Delete** — `array.removeByValue(array.elementById(key))`. `removeByValue`
  matches the membership entry by link and is idempotent, so concurrent deletes of
  distinct keys merge.

The lunch poll derives a vote's key as `JSON.stringify([voterName, optionId])`
and an option's key as its generated `id`; castVote, clearMyVote, and the
removeOption cascade all recompute the same key, so they reach the same entity
without scanning the list.

## Why this instead of server-side keyed ops

An earlier design added four key-aware server ops — `insert-unique`, `upsert`,
`set-by-key`, `remove-by-key` — each carrying a list of key field paths the server
would extract and compare. Deterministic addressing makes that machinery
unnecessary:

- The identity lives in the **link** (the deterministic entity id), so the
  server's existing value-equality `add-unique` and `remove-by-value` already
  dedup and remove *by identity* when the value is a link — no key extraction on
  the server, no new op kinds.
- "Set my value" and "edit a field" become plain writes to the keyed entity's
  document. Path-overlap conflict detection already merges concurrent writes to
  different fields and resolves same-field writes last-writer-wins, so there is
  nothing to add for the update case.
- Removal by a non-identity field (the removeOption → votes cascade, "remove every
  vote for this option") is the one shape deterministic addressing does not turn
  into a single op. It is handled by reading the list to enumerate the matching
  keys and issuing one `removeByValue` per key. That read is retained in the
  conflict set, so a concurrent change to the vote list makes the cascade conflict
  and retry — catching a vote cast for the option after the read.

The cost is that the key must be derivable by the handler (it is, for the poll),
and that two different real-world entities must not collide on a key (the poll's
keys — a vote's `(voter, option)` and an option's generated id — do not).

## Conflict and merge semantics

| Concurrent pair (same key) | Result |
| --- | --- |
| addUnique / addUnique | one membership entry (dedup by link) |
| entity set / entity set, different fields | both fields set (merge) |
| entity set / entity set, same field | last applied wins |
| removeByValue / removeByValue | removed once (idempotent) |
| addUnique (or set) / removeByValue | server-arrival order — the later op wins |

The last row carries the add-wins-after-delete tension documented for `append`: a
remove and a concurrent stale add resolve by arrival, so an add that lands after a
remove resurrects the key. This is the price of never conflicting; a handler that
needs delete to win must keep a read-modify-write `set`.

Like the whole-value ops, a keyed op drops only the reads its own write issues
(the list value and the `["cfc"]` policy label), so operations on different keys
do not false-conflict. The op's touched path for *other* readers stays the array
path, so a reader of the whole list is still invalidated.

## The entity outlives its link: clear on remove

A keyed element is two things — a membership link in the array, and the entity
document the link points at. `removeByValue` (and a whole-list `set([])`) drops
the link but does not delete the entity document; there is no orphan-entity
collection. So a handler that decides anything by reading the entity (the
castVote toggle reads "do I already have this vote?") must clear the entity when
it removes the membership, or a later read returns the removed value's stale
content. The lunch poll pairs every vote removal — toggle-off, clearMyVote, the
removeOption cascade, and resetVotes — with a `set(undefined)` of the entity. The
alternative, deciding membership by reading the array, would reintroduce the
whole-list read this design exists to avoid.

## Back-compatibility: addressing scheme changes

This moves the poll's options and votes from append-addressed entities (a `push`
mints the entity id from a per-frame counter folded together with the event
cause) to content-addressed entities (`elementById` derives the id from the key
alone). The two id derivations never coincide, so a poll created before this
change holds options and votes the new handlers cannot reach:
`options.elementById(id).get()` and `votes.elementById(key).get()` return
undefined for pre-existing records, so editing or removing an old option
silently no-ops, and toggling an old vote adds a parallel new-scheme vote that
double-counts in the tally. There is no data migration for pattern instances, so
this applies to fresh polls; existing deployed polls would need to be recreated
to benefit.

## The danger with `push`, and making it safe

Making `push` mergeable created a hazard for a **conditional** append — one whose
correctness depends on first reading the list, like "append only if this name is
absent." See `mergeable-collection-writes.md` ("Danger: a conditional push") for
the full treatment. Two responses are implemented:

1. **Address by identity where the condition is uniqueness.** A uniqueness
   condition becomes "add this entity, deduped by its link" — `elementById` then
   `addUnique` — which the server enforces against durable state with no retry.

2. **Keep the conflict net for other conditions automatically.** The
   incidental-read drop drops only the reads the op itself issues, not the
   handler's own explicit `.get()`. So a handler that reads the list and then
   writes still records that read and conflicts-and-retries.

The lunch poll's participant join (`addUser`) is deliberately left as a
read-then-push: its condition is not a simple key-uniqueness but "do not let a
second person take a name already in use," whose correctness needs the abort, not
a dedup. Response 2 keeps it safe — concurrent same-name joins conflict on the
retained read and one retries and bails. A third response, a build-time diagnostic
that flags read-then-mergeable-push and points at the identity-addressed
`addUnique`, is not yet built.

## Generality

A keyed list of records is one of the most common shapes; this approach applies
beyond the poll:

- **Membership / join lists** — `addUnique` an entity addressed by a member id or
  name (room participants, collaborators, attendees).
- **Per-key user state** — address by `(user, target)` and set the entity: votes,
  reactions, RSVPs, read-receipts, ratings, per-row selection.
- **Record editing** — `elementById(id).key("field").set(...)`: toggling a todo's
  done flag, editing a row's title, any "edit field F of row K" in a table.
- **Deletion** — `removeByValue(elementById(id))`: deleting a row, removing my
  entry; cascade deletes enumerate the foreign key and remove each match.
