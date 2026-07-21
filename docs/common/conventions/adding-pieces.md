# Adding Pieces

To add a new piece to the space's piece list, use the `addPiece` handler
exported by the default app pattern. **Never** push to `allPieces` directly.

## Why

- **Type safety** — no `as any` casts needed
- **Deduplication** — `addPiece` checks for duplicates before adding
- **Transaction semantics** — proper commit/retry via the handler system
- **Encapsulation** — patterns don't depend on the internal shape of the default
  app's state

## Usage in an `action()`

The most common case — creating a piece in response to a user interaction:

```tsx
// Shown for illustration only.
import { action, pattern, resultOf, wish, Stream, UI } from "commonfabric";
import { MentionablePiece } from "@commonfabric/piece";

// Wish for the addPiece handler at pattern body level
const defaultApp = wish<{ addPiece: Stream<{ piece: MentionablePiece }> }>({
  query: "#default",
});
const { addPiece } = resultOf(defaultApp.result);

const createNote = action(() => {
  const note = Note({ title: "New Note", content: "", noteId: generateId() });
  addPiece.send({ piece: note });
  return navigateTo(note);
});

return {
  [UI]: <cf-button onClick={createNote}>New Note</cf-button>,
};
```

## Usage in a `handler()`

When you need reusable logic that can be bound to different state:

```tsx
// Shown for illustration only.
import { handler, resultOf, Stream } from "commonfabric";
import { MentionablePiece } from "@commonfabric/piece";

// Define at module scope
const createNoteHandler = handler<
  { title: string; content: string },
  { addPiece: Stream<{ piece: MentionablePiece }> }
>(({ title, content }, { addPiece }) => {
  const note = Note({ title, content, noteId: generateId() });
  addPiece.send({ piece: note });
  return note;
});

// Inside pattern body — bind with the wished stream
const defaultApp = wish<{ addPiece: Stream<{ piece: MentionablePiece }> }>({
  query: "#default",
});
const { addPiece } = resultOf(defaultApp.result);

return {
  createNote: createNoteHandler({ addPiece }),
};
```

## Anti-patterns

### Direct mutation

```tsx
// Shown for illustration only.
// BAD — direct mutation, no deduplication
const { allPieces } =
  resultOf(
    wish<{ allPieces: Writable<NotePiece[]> }>({ query: "#default" }).result,
  );
allPieces.push(newNote);
```

### Type hack

```tsx
// Shown inside a pattern body.
// WORSE — hides type errors behind `as any`
allPieces.push(note as any);
(allPieces as any).push(note);
```

### Wishing for `allPieces` as Writable

```tsx
// Shown inside a pattern body.
// BAD — exposes internal implementation of default-app
wish<{ allPieces: Writable<MinimalPiece[]> }>({ query: "#default" });
```

Instead, wish only for the `addPiece` stream:

```tsx
// Shown at module scope.
// GOOD — depends on the handler contract, not internal state
wish<{ addPiece: Stream<{ piece: MentionablePiece }> }>({
  query: "#default",
});
```

## How it works

The `addPiece` handler is defined in `default-app.tsx` and exported as a
`Stream<{ piece: MentionablePiece }>`. Internally it checks for duplicates
and pushes to the owned `allPieces` Writable. The runtime infrastructure
(`PieceManager.add()`) also uses this handler — patterns should follow the
same approach.

See [handler()](../concepts/handler.md) for handler mechanics and
[wish()](wish.md) for wish usage.
