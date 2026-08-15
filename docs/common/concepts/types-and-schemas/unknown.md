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

- **Is something there.** The field is truthy when the target holds a value and
  falsy when it does not, so `if (mention)` and `mention !== undefined` mean
  what they say.
- **Is it the same thing as that.** `equals(mention, other)` compares the two by
  identity, resolving both sides first, so it holds whether each side arrived as
  a reference or as a cell.
- **Where does it point.** Writing the value into another field stores a link to
  the same document rather than an inline copy of it.

Everything else is absent. The value carries no properties of the target, so
reading one yields `undefined` rather than the target's data — and the compiler
rejects the attempt before it runs, naming the property and asking for a type
that declares it.

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
