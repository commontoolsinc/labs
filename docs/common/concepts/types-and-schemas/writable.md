# Writable<>

`Writable<>` in type signatures indicates **write intent** (`.set()`, `.push()`,
`.update()`), not reactivity — everything is reactive by default, including
plain `number` or `Item[]` inputs. See [Reactivity and Write Access](../reactivity.md).

## Writable Methods

With `Writable<T>` in your signature:

| Method | Purpose |
|--------|---------|
| `.get()` | Read current value |
| `.set(value)` | Replace entire value |
| `.update({ key: value })` | Partial update (objects) |
| `.push(...items)` | Add to array |
| `.remove(item)` | Remove first `item` from array |
| `.removeAll(item)` | Remove all `item` from array |
| `.key(...keys)` | Navigate nested data, e.g. `.key("property")` |

Without `Writable<>`, you can still display values in JSX, pass to `computed()`, and map over arrays - all reactively. Note: Outside of JSX, filtering and transformations must be done in `computed()`.

## Passing Values to Pattern Inputs

When calling a pattern, you have two options for providing input values:

**Plain values** create independent state for each pattern instance:

```typescript
// Shown inside a pattern body.
const counter1 = Counter({ count: 0 });
const counter2 = Counter({ count: 0 });
// counter1 and counter2 have separate state - incrementing one doesn't affect the other
```

**Cell references** share state across pattern instances:

```typescript
// Shown inside a pattern body.
const sharedCount = new Writable(0);
const counter1 = Counter({ count: sharedCount });
const counter2 = Counter({ count: sharedCount });
// counter1 and counter2 share state - incrementing one affects both
```

For most cases, pass plain values. Use `new Writable()` when you intentionally want multiple patterns to share the same underlying state.

Note: The `Writable<T>` annotation in a pattern's type signature indicates write intent within that pattern, but doesn't affect how input values are coerced. Plain values always become owned state that the pattern can modify—the pattern can pass these to handlers with `Writable<>` inputs, making them effectively writable regardless of the signature.

## Storing References to Cells

When storing a "pointer" to a Cell (e.g., tracking which item is selected), **box the reference** in an object:

```typescript
// Shown for illustration only.
// ✅ Correct - Boxed reference
interface Input {
  selected: Writable<{ item: Item }>;
}
selected.set({ item });
const { item } = selected.get();
```

Why: When you store a Cell directly, link chain resolution means `.set()` writes to the *target* instead of changing which item is referenced. Boxing breaks the chain.

See [Cell Reference Overwrite](../../../development/debugging/gotchas/cell-reference-overwrite.md) for details.

## Writable<T[]> vs Writable<Array<Writable<T>>>

**Use `Writable<T[]>` by default:**

```typescript
import { handler, Writable } from 'commonfabric';

interface Item {
  title: string;
  done: boolean;
}

const addItem = handler<unknown, { items: Writable<Item[]> }>(
  (_, { items }) => {
    items.push({ title: "New", done: false });
    items.set(items.get().filter(x => !x.done));
  }
);
```

**Use `Writable<Array<Writable<T>>>` only when you need identity comparison on
elements** (via `equals()` from `commonfabric`; cells also expose an
equivalent `.equals()` method):

```typescript
// Shown at module scope.
import { equals, handler, Writable } from 'commonfabric';

const removeItem = handler<
  unknown,
  { items: Writable<Array<Writable<Item>>>; item: Writable<Item> }
>((_, { items, item }) => {
  const index = items.get().findIndex(el => equals(el, item));
  if (index >= 0) items.set(items.get().toSpliced(index, 1));
});
```

See [Object Identity and Equality](../identity.md) for the full `equals()` model.

## Schemas Filter Visibility

Schemas act as a visibility filter at runtime. When you read a reference typed
as `SomeInterface`, only properties declared in that interface are visible —
everything else is dropped, even if the underlying data contains it. This is a
common source of mysterious `undefined`s.

```typescript
// Shown at module scope.
// If Notebook.notes is typed as NotePiece[]...
interface NotePiece { title?: string; noteId?: string; }

// ...then parentNotebook is invisible when reading through notes,
// even though the Note's own data contains it.
notebook.notes[0].parentNotebook  // undefined (not in NotePiece)
```

**Fix:** Add the property to the shared interface so it's visible through the schema.
