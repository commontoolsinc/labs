## References: `unknown`

**Declare a field `unknown` when it holds a reference to another piece that this
pattern tests, compares, and passes on, but never reads through.** A wider
declaration retrieves the piece instead of pointing at it: declared as its own
type, the field reads back as the whole expanded piece, `$UI` tree and all, and
every reader of the field inherits that cost.

```typescript
// Shown as interface or class members.
/** The pieces this note points at. Compared by identity, never read through. */
mentions: unknown[] | Default<[]>;
```

A read of such a field does not descend into what it points at. What comes back
answers three questions and no others:

- **Is something there.** The field is truthy when the position holds anything
  and falsy only when it holds nothing, so `if (mention)` and
  `mention !== undefined` mean what they say. A stored `0`, `""`, `false` or
  `null` is *something*, so it is truthy here — the bit answered is presence,
  not the value's own truthiness.
- **Is it the same thing as that.** `equals(mention, other)` compares the two by
  identity, resolving both sides first, so it holds whether each side arrived as
  a reference or as a cell.
- **Where does it point.** Writing the value into another field stores a link
  rather than an inline copy. The link addresses the position it was read from,
  which resolves to the same document — so a value read from a transient event
  and written into a durable field stores a pointer into that event.

Everything else is absent, whatever sits behind the position: a stored string
is as opaque as a stored object, and an array reads back as a reference rather
than an array. Reading a property yields `undefined`.

The compiler catches some of these before they run — `schema:unknown-type-access`
names a property read directly off a lift or handler parameter — but not all of
them: reaching the field through an array element inside a callback is outside
it. `docs/development/debugging/gotchas/unknown-typed-field-reads-a-reference.md`
is the debugging entry point when a read comes back empty.

`===` and `includes()` do not work on these: two reads of the same reference are
distinct objects. `equals()` is what compares them.

```typescript
// Shown at module scope.
import { type Default, equals, lift } from "commonfabric";

/** Whether any of a note's mentions points at the given piece. */
const cites = lift((
  { mentions, piece }: { mentions: unknown[] | Default<[]>; piece: unknown },
): boolean =>
  !!piece && mentions.some((mention) => equals(mention as object, piece as object))
);
```

### Reading through a reference

To read what a reference points at, say so in the declaration. Two ways, and
the choice is about who does the reading:

- **A cell** — `ComparableCell<unknown>`, `ReadonlyCell<T>`, `Cell<T>` — hands
  the field's holder a handle. Nothing is read until someone calls `.get()` on
  it, and the reader that does is the one that takes the dependency.
- **A declared shape** — `{ title: string }` — reads that shape eagerly, and
  nothing beyond it. Use it when the reader always wants those fields, and keep
  it as narrow as the reader actually is.

Prefer whichever names the smaller surface. A reference that is only compared
wants `unknown`; one whose title is rendered wants a two-field projection, not
the piece.

### `unknown` is not `any`

They admit the same values and mean opposite things here. `any` says "fetch it
all, I will sort it out", and a field declared that way reads back as the whole
value. `unknown` says "this is a reference; do not fetch it". Reaching for `any`
to quiet a type error on a reference silently pulls the piece it names.
