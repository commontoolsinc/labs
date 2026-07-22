# Migrating a collection write

This note is for someone changing a handler that reads a collection and then
writes to it — most often because the compiler reported
`mergeable-push:read-then-push`. It says which replacement to pick, and it
describes the mistakes that make a migration look finished while it is not.

For why the mergeable operations exist, see
[mergeable-collection-writes.md](./mergeable-collection-writes.md). For how a
keyed element is addressed, see
[keyed-collection-writes.md](./keyed-collection-writes.md). This note assumes
both and covers the migration itself.

## Pick the replacement from what the read is for

Read the handler and decide what the read actually decides. There are four
answers and they do not share a remedy.

**The read is a uniqueness check.** The handler asks "is this thing already in
the list?" and appends when it is not. Give the element a deterministic address
with `elementById(key)` and add it with `addUnique`. The dedup then happens on
the server by link, so two clients adding the same key resolve to one entity
with no retry, and adds of different keys merge.

**The appended value is derived from the list.** The handler numbers the new
element, labels it from the existing entries, caps the list at a maximum
length, or reports the new element's index back to its caller. None of that is
expressible as an append, because an append carries no condition and the server
resolves it at the durable tail, which need not match the snapshot the handler
read. Use one read-modify-write `set` over the snapshot the handler already
read. The read stays in the conflict set, which is what makes the retry correct.

**The read feeds a different write to the same collection.** The handler
appends an entry and then separately trims or reorders the list. Keep the
independent read-modify-write in its own handler so the append stays mergeable.
A transaction that both appends and reshapes the whole array may drop the
reshape — see "Mixed whole-array reshape" in
[mergeable-collection-writes.md](./mergeable-collection-writes.md).

**The read is unrelated to the write.** Leave the `push` alone. The append
forfeits merging, and there is no better expression to move to.

Picking the wrong one of these is a regression, not a neutral choice. Replacing
a `push` with `set([...current, value])` when the read was a uniqueness check
makes the write strictly worse: the uniqueness is still not enforced, and the
whole-array write can now clobber a durable tail that the append would have
respected.

## `addUnique` and `removeByValue` need an actual cell

This is the rule that breaks migrations, and it fails silently in both
directions.

Both methods compare the argument against the array's **stored** elements. An
element that is an object is its own entity, so the stored element is a link,
not the object's content. The methods choose how to compare by asking whether
the argument is a cell — `isCell` is an `instanceof` check against the cell
implementation, nothing more:

```ts
// Shown for illustration only.
isCell(candidate)
  ? areLinksSame(element, candidate, ...)  // compares by link identity
  : deepEqual(element, candidate)          // compares against the stored link
```

A value read back out of `.get()` is a query-result proxy. It carries a link,
but it is not a cell, so it takes the `deepEqual` branch and is compared
against a link sigil, which it never equals. The consequences:

```ts
// Shown for illustration only.
// Silently removes nothing. `row` is a proxy, not a cell.
for (const row of items.get().filter((r) => r.name === name)) {
  items.removeByValue(row);
}

// Silently adds a duplicate, for the same reason.
items.addUnique(items.get().find((r) => r.name === name));
```

The compiler reports both, as `mergeable-write:value-argument`. It reports the
call whenever the collection's elements are objects and the argument is
certainly not a cell, and it stays quiet where the value form is right: an
argument it cannot decide, and a collection of scalars, which store inline
rather than as links and so do compare by value. The check exists because
neither the type system nor the runtime can: the parameter is declared
`U | AnyCell<U>`, so both forms type-check, and the call succeeds either way.

Neither call reports anything. The first is a no-op, so code that reads as a
cleanup does nothing at all. The second is worse than a no-op: it appends a
second element for a key that already has one.

Pass a cell instead — the cell from `elementById(key)`, or the element cell
from `key(index)`:

```ts
// Shown for illustration only.
const entry = items.elementById(key);
entry.set({ name, description: "" });
items.addUnique(entry);        // compares by link, dedups correctly
items.removeByValue(entry);    // compares by link, removes correctly
```

### Event data is a cell only if its type says so

The same rule catches handler inputs. A handler whose event type names a plain
type receives a proxy, and `addUnique` on it silently duplicates:

```ts
// Shown for illustration only.
// The event field is a plain type, so `piece` arrives as a proxy and this
// never dedups.
handler<
  { piece: MentionablePiece },
  { pieceRegistry: Writable<MentionablePiece[]> }
>(({ piece }, { pieceRegistry }) => {
    pieceRegistry.addUnique(piece);
  },
);

// Declaring the field as a cell makes the same call compare by link.
handler<
  { piece: Writable<MentionablePiece> },
  { pieceRegistry: Writable<MentionablePiece[]> }
>(({ piece }, { pieceRegistry }) => {
  pieceRegistry.addUnique(piece);
});
```

If a handler nearby compares the same value with `equals(a, b)` rather than by
identity, that is a sign the value is a link-carrying proxy rather than a cell:
`equals` resolves links before comparing, so it works where `addUnique` does
not.

## Finish the migration: remove the read

The compiler inspects `push`. It does not inspect `addUnique` or
`removeByValue`, because those are the recommended replacements. So swapping
`push` for `addUnique` while keeping the `.get()` of the same list silences the
diagnostic without changing what the handler does under contention: the
handler's own explicit read stays in the conflict set, and the write still
conflicts and retries exactly as it did before.

A migration that keeps the whole-list read has not bought anything. It has
moved the shape out of the compiler's view. When the keyed form is the right
answer, read the keyed entity rather than the array:

```ts
// Shown for illustration only.
const entry = items.elementById(key);
if (entry.get()) return;       // reads one entity, not the list
entry.set(value);
items.addUnique(entry);
```

If the read genuinely has to stay, keep it deliberately and say so in a
comment, so the next reader knows the write still contends.

## Clear the entity when you drop the membership

A keyed element is a membership link in the array and an entity the link points
at. Removing the link does not delete the entity. A handler that decides
anything by reading the entity must clear it when it removes the membership:

```ts
// Shown for illustration only.
items.removeByValue(entry);
entry.set(undefined);
```

Without the clear, the entity outlives its link and a later read returns the
removed value's content. The failure is silent and shaped like data loss: a
handler that asks "does this already exist?" finds the orphan, takes the
already-exists branch, and never restores the membership, so the element can
never come back.

## Do not invent a per-handler legacy migration

An element appended by `push` takes its entity identity from an append counter
folded with the event cause. An element addressed by `elementById` derives its
identity from the key. The two derivations never coincide, so changing a
collection to keyed addressing makes elements written by the old code
unreachable from the new code. The decision already taken for this repository
is that there is no data migration for pattern instances: existing instances
would need to be recreated. See "Back-compatibility: addressing scheme changes"
in [keyed-collection-writes.md](./keyed-collection-writes.md).

Writing a legacy fallback into each handler is not a free improvement on that
decision, and it costs more than it looks.

The fallback needs the whole-list read to find the legacy element. That read
stays in the conflict set, so the migration does not buy the merge behaviour it
was for: writers still conflict and retry, exactly as they did before.

A legacy element can be removed, but only through a cell. `elementById` does not
address one — that is what makes it legacy — and `removeByValue` of its content
is the silent no-op above. The scan that found the element also gives its index,
and `items.key(index)` is a cell for it, so `removeByValue(items.key(index))`
removes it. That cell is positional: it resolves against the snapshot the
handler read, so a concurrent insert or removal ahead of it addresses a
different element. The retained read is what keeps that from being wrong — a
commit carrying a stale read is rejected and retries — and it is the same read
that costs the merge behaviour. The fallback is contended by construction, not
broken.

The failure to avoid is handing `removeByValue` the element's content rather
than its cell. The scan has just produced the content, so it is the natural
thing to reach for, and it removes nothing. The keyed write beside it does
something, so the result is a permanent duplicate: the legacy element and the
keyed element both live in the list, both render, and both feed whatever reads
the list. Nothing reports any of it.

If existing data really must be carried across, prefer a one-shot repair to a
scan in every handler. It pays the whole-list read once rather than on every
write, and it keeps the positional addressing in one place.

## Test the path you added

A pattern's test suite usually starts from an empty collection, so it exercises
only the freshly-keyed path. A legacy fallback, and any handler that branches on
whether an element already exists, is invisible to a suite shaped that way — the
suite passes and the branch has never run.

Seed the pre-existing element the branch is written for, then drive the handler
and assert on the whole collection, not just the element you were looking for. A
duplicate is the expected failure here, and an assertion that only checks "my
element is present" will not see it.
