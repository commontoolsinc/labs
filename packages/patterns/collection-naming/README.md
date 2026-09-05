# Collection naming

A library a collection pattern calls to give its members names of its own, and
an exemplar collection that uses it. The Topics board in
[`../topics/`](../topics/README.md) is the collection it exists for and calls
the same library. The design is
[Naming in collections](../../../docs/specs/collection-naming.md); this
directory is its first customer. Member names here are decimal strings, dense
from `1`, so a member is cited as `<collection>/42`.

## The library: `naming.ts`

The namespace is one map cell on the collection, `names: { "42": <member> }`,
holding each member as an unread reference. The library owns everything a
collection does with it:

- **Allocation.** `assignName(names, member)` computes the next name — `1` when
  the map holds none, otherwise one more than the largest present — and records
  the member under it, in the transaction of the verb that calls it. A keyset
  read of the map conflicts with a concurrent key write to it, so of two verbs
  that read the same keys the second to commit is rejected, re-runs against the
  first one's write, and takes the name after it. `nextNameAmong()` is the rule
  on its own, over any list of keys.
- **The names table.** `namesTable` derives one row per named member,
  `{ member, name }`, each row addressed by the member it describes. A
  collection derives it once and hands it to every member it creates.
- **Reverse lookup.** `nameOf(member, table)` returns the name the table gives a
  member, matched by identity, or `undefined`. `ownName` is the same lookup as a
  lift, for a member reading its own row out of its collection's table.
- **The backfill.** `backfillNames(members, names)` names every unnamed member
  of a list in filing order, skips those already named, and returns exactly the
  names it wrote — `[]` on a second run, which writes nothing.
- **The declaration.** `NamingDeclaration` is what a collection publishes so a
  consumer learns the policy rather than assuming one: whether a name is unique
  across history or only among current members, whether it is permanent, whether
  it may be reused, and what allocates it. `SEQUENCE_NAMING` is the declaration
  for this sequence: unique across history, permanent, never reused, and
  eligible for the compact `<collection>-42` spelling because a decimal name
  holds no hyphen. Its `name` — the collection's own — is optional and absent on
  the exemplar: the stage that binds the board's namespace as a slug fills it,
  and that binding is what a resolver can then check the declaration against.

Nothing in `naming.ts` knows what kind of piece a member is. A member is a cell,
compared by identity and never read through, which is what keeps every read
there — the allocator surveying keys, the table over the map, a member finding
its row — from expanding a member document.

### Declaring the namespace

A collection declares the map at its input as
`names?: Writable<Default<NamesMap, {}>>`, written inline at the property, and
publishes it under the same default. Two details of that spelling decide whether
the reads above stay bounded:

- The two-argument `Default`. `NamesMap | Default<{}>` adds a bare empty-object
  arm to the union, and wherever that union reaches a handler unmerged it
  becomes an `anyOf` whose empty arm reads every value whole; the runtime's
  merge lets a branch that looked win over the opaque one, so the allocator
  would expand every member to survey the keys.
- Inline, not through an alias. The schema generator reads the default off the
  property's own type node, so a default declared through a type alias is
  dropped from the schema.

A verb reads its binding through a schema that carries no default, so inside a
verb the map is `undefined` until the first name is written. `NamesMapCell`
declares that structurally, and the library's readers take an absent map as
empty.

## The mention universe: `mentionable.ts`

The one derivation both this exemplar and the Topics board build their mention
universe with. `mentionableIndex` reads three display strings off each member —
its display name, its title, and its own `shortName` — and returns one document
of `MentionableRow` copies, each carrying the member itself as an unread
reference under the `piece` key;
[the mentionable convention](../../../docs/common/conventions/mentionable.md) is
what the editors consume it through. `mentionableRowsOf` is the per-member
projection on its own, over any list of cells.

Copies rather than the members are what bounds the read, and that is what
separates a universe from an index: a survey index whose rows ARE the members
costs nothing extra, because a survey reads those members anyway, while the
universe is read by EVERY member's editor — wiring it to the members would
multiply the collection by itself.

It is a module of its own rather than part of `naming.ts` because it reads
THROUGH a member, which is exactly what that module does not do; and it is one
module rather than a copy per board because a board importing the other board's
copy would carry that whole board into its own program.

## The exemplar: `board.tsx` and `item.tsx`

The board is a collection of items that owns a member namespace, and the demos
in the plan run on it. Its verbs:

- `addItem({ title, body?, agentName })` allocates the next name and appends the
  item in one write, so the created item is reachable at `names[<n>]` the moment
  it exists. It returns the item, declared through the index's row schema, with
  the allocated `name` beside it: the item's own `shortName` is a derivation
  that may not have run when the call returns, and a caller must not have to
  wait for it to learn the name it just allocated.
- `backfillNames({ agentName })` names every unnamed member in filing order and
  returns the names it wrote. Idempotent. It writes the namespace and nothing
  else, and on a board whose members were filed past `addItem` that is not the
  whole job: a name reaches an index row through the member's own `boardNames`
  wiring, so the backfill has to be paired with a one-time link-bind of the
  board's `namesTable` onto each member it named. Until that bind the member is
  named — `names` and `namesTable` carry it, and `nameOf` returns it — and its
  row still reads the empty string.

It publishes `index` — the items themselves, declared through a row schema of
`title`, `createdAt`, and `shortName`, so a row IS its item and a row's own
address is the item's address; `shortName` defaults to the empty string for a
member whose lookup has produced no value, so a board holding older members
still reads whole — and `names`, `namesTable`, `naming`, `mentionable`,
`itemCount`, and a card list showing each item with its name.

An empty `shortName` covers two cases a survey cannot tell apart: a member
nothing has named, and a member the board has named whose `boardNames` was never
wired. A caller that needs to know which reads the namespace, where the answer
is: `nameOf` over `namesTable` returns the name for either, and returns
`undefined` only for the first.

`mentionable` is the board's mention universe, derived through
`mentionableIndex` from `mentionable.ts` above. Every item the board creates is
wired to it, so an item's body editor completes `#42` over the board's own
numbering. The query matches a row's copied `shortName`, taken off the member's
own — the same property a member publishes for itself, and the one `index` shows
— so one fact is derived once and the editor reads one name at both ends. That
is what lets offering the list expand no member; what a picked completion stores
is the member itself.

A member whose `boardNames` never arrived reads blank in the universe for the
reason its index row does, so the link-bind the backfill has to be paired with
governs both.

The item is the member: a title, a body, a filing time, and the board's names
table wired in at creation as `boardNames`. Its body is drafted per session and
written with its mention map by one save, and the three streams that drive that
— `startEditBody`, `saveBody`, `cancelEditBody` — are the whole editing surface.
The drafts are seeded by the open and by nothing else, so the save refuses when
no edit is open and a second open leaves one in progress alone: either would
otherwise write an empty or stale draft over the stored body. It reads its own
row out of that table by identity and publishes the result as `shortName`,
rendering it as a badge beside the title when it has one; a mention of the item
elsewhere reads that same `shortName` to show the number on its pill. The body
is edited through `cf-code-editor`, which mints reference-form mentions into the
item's own `references` map — saved with the prose in one transaction, so the
tokens and the destinations they name land together. An item wired to no board
shows no name and needs nothing else.

Headless, against a deployed board:

```bash
cf piece call --cell /of:<board> addItem --json '{"title":"...","agentName":"Sol"}'
# -> { "result": { "item": { "title": "...", ... }, "name": "1" } }
cf cell get /of:<board> names
# -> { "1": {}, "2": {} }
cf cell get /of:<board> index --select @,title,shortName
cf piece call --cell /of:<board> backfillNames --json '{"agentName":"Sol"}'
```

## Tests

- `naming.test.tsx` — the sequence rule, the allocator re-run against a stale
  read (a first allocation, a concurrent writer's key landing, and a re-run over
  the map as the winner left it, which takes the next distinct name), the
  reverse lookup, and the declaration.
- `board.test.tsx` — the exemplar end to end: allocation on create, one more
  than the largest name present, a name kept through a rename and through
  leaving the list, the backfill and its idempotence, index rows that are the
  members and the default an unnamed member's `shortName` reads as, the mention
  universe and the name each of its rows carries, the item reading its own name,
  the bound on what a read of the namespace or the universe expands, a board
  given no namespace at all, and the rejections.
- `topics-shape.test.tsx` — a test-only board whose members are the real `Topic`
  pattern, wired through the library the way the exemplar is. It holds the
  library to a member pattern it does not own — allocation on create, the
  backfill, the names table, and the reverse lookup, all over topics, through a
  board that is not the Topics board.

## Topics

The Topics board (`../topics/`) is the collection this library exists for, and
it calls it: `addTopic` allocates in the same transaction as its append,
`backfillNames` names what the board held before, each topic reads its own name
out of `boardNames` and publishes it as `shortName`, and both boards derive
their mention universe through `mentionable.ts`. What is still to come is in
[the plan](../../../docs/plans/collection-naming-topics.md): the production
backfill, which needs the one-time link-bind of `namesTable` onto every topic
filed before the namespace, and the slug that binds the board's `names` cell as
`top`.
