# Types and Schemas

## Type Contexts

Four contexts where types appear differently:

```tsx
import { Default, Writable, pattern, UI } from 'commontools';

interface ShoppingItem {
  title: string;
  done: Default<boolean, false>;
}

// Context 1: Schema definition
interface Input {
  items: Default<ShoppingItem[], []>;
}

// Context 2: Pattern parameter (with Writable<> for write access)
interface WritableInput {
  items: Writable<ShoppingItem[]>;
}

export default pattern<WritableInput>(({ items }) => {
  // Context 3: items is Writable<ShoppingItem[]>

  return {
    [UI]: (
      <div>
        {items.map((item) => (
          <ct-checkbox $checked={item.done}>{item.title}</ct-checkbox>
        ))}
      </div>
    ),
  };
});
```

## Schema Visibility

Schemas act as a visibility filter at runtime. When you read a reference typed as `SomeInterface`, only properties declared in that interface are visible — everything else is dropped, even if the underlying data contains it.

```typescript
// If Notebook.notes is typed as NotePiece[]...
interface NotePiece { title?: string; noteId?: string; }

// ...then parentNotebook is invisible when reading through notes,
// even though the Note's own data contains it.
notebook.notes[0].parentNotebook  // undefined (not in NotePiece)
```

**Fix:** Add the property to the shared interface so it's visible through the schema.
