# Collection naming

A library a collection pattern calls to give its members names of its own, and
an exemplar collection that uses it. The design is
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

Nothing in the library knows what kind of piece a member is. A member is a cell,
compared by identity and never read through, which is what keeps every read here
— the allocator surveying keys, the table over the map, a member finding its row
— from expanding a member document.

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

## The exemplar: `board.tsx` and `item.tsx`

The board is a collection of items that owns a member namespace, and the demos
in the plan run on it. Its verbs:

- `addItem({ title, body?, agentName })` allocates the next name and appends the
  item in one write, so the created item is reachable at `names[<n>]` the moment
  it exists. It returns the item's index row, name included.
- `backfillNames({ agentName })` names every unnamed member in filing order and
  returns the names it wrote. Idempotent.

It publishes `index` (one row per item: the item as a reference, `title`,
`createdAt`, and `name`, defaulted to the empty string for a member the board
has not named), `names`, `namesTable`, `naming`, `itemCount`, and a card list
showing each item with its name.

The item is the member: a title, a body, a filing time, and the board's names
table wired in at creation as `boardNames`. It reads its own row out of that
table by identity and publishes the result as `shortName`, rendering it as a
badge beside the title when it has one. An item wired to no board shows no name
and needs nothing else.

Headless, against a deployed board:

```bash
cf piece call --cell /of:<board> addItem --json '{"title":"...","agentName":"Sol"}'
# -> { "result": { "item": { "member": { "$link": ... }, "name": "1", ... } } }
cf cell get /of:<board> names
# -> { "1": {}, "2": {} }
cf cell get /of:<board> index
cf piece call --cell /of:<board> backfillNames --json '{"agentName":"Sol"}'
```

## Tests

- `naming.test.tsx` — the sequence rule, the allocator re-run against a stale
  read (a first allocation, a concurrent writer's key landing, and a re-run over
  the map as the winner left it, which takes the next distinct name), the
  reverse lookup, and the declaration.
- `board.test.tsx` — the exemplar end to end: allocation on create, one more
  than the largest name present, a name kept through a rename and through
  leaving the list, the backfill and its idempotence, index rows and the default
  an unnamed member's row reads as, the item reading its own name, the bound on
  what a read of the namespace expands, a board given no namespace at all, and
  the rejections.
- `topics-shape.test.tsx` — the rehearsal for the Topics board: a test-only
  board whose members are the real `Topic` pattern, unmodified, wired through
  the library the way the exemplar is. It proves the board side; the item side
  is proven on the exemplar item.

## Topics

The Topics board (`../topics/`) is the collection this library exists for. It
adopts the library with the wiring the rehearsal board already carries, and its
topic gains the item-side display the exemplar item proves, on the schedule in
[the plan](../../../docs/plans/collection-naming-topics.md).
