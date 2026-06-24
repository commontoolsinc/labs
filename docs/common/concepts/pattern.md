# Patterns

A pattern is a TypeScript/JSX program that defines reactive data transformations with an optional UI. You instantiate a pattern by binding it to specific cells (see the cell-graph diagram under [Piece in the glossary](./glossary.md#piece)).

## Input and Output Types

Explicitly define types for your pattern inputs and outputs.

**Naming convention:** Prefix Input and Output interface names with the pattern name, e.g. `TodoListInput`/`TodoListOutput`, `ContactDetailInput`/`ContactDetailOutput`. Avoid generic `Input`/`Output` names — they collide across files and make imports ambiguous.

The type declares what data it expects and _how_ it is accessed.

```typescript
// Shown at module scope.
interface TodoInput {
  items?: Writable<Todo[] | Default<[]>>;
  title?: Writable<string | Default<"untitled">>;
}

interface TodoOutput {
  items: Todo[];
  title: string;
  addItem: Stream<{ text: string }>;
}

export default pattern<TodoInput, TodoOutput>(({ items, title }) => {
  // ...
  return { items, title, addItem };
});
```

### Input Types

Input types describe what the pattern receives when instantiated. Use `Writable<>` only for state the pattern intends to mutate — plain types are still reactive (see [Reactivity and Write Access](./reactivity.md)).

**Guideline:**

- It's explicitly ok to pass a plain type to a pattern that requests `Writable<>`; the framework handles write intent transparently.
- Add `Type | Default<Value>` with a reasonable initial state for most inputs, unless it really makes no sense to use the pattern without that value being passed in.

### Output Types

Output types describe what the pattern returns. They should exactly mirror the return object without additional wrapping:

```typescript
// Shown at module scope.
interface MyOutput {
  count: number;               // Not Writable<number>
  items: Item[];               // Not Writable<Item[]>
  increment: Stream<void>;     // Exported handler
}
```

The output type reflects the *shape* of the returned data, not how it's stored internally.

### Always Use Dual Type Parameters

**Always use `pattern<Input, Output>()`** for production patterns:

```typescript
// Shown for illustration only.
// ✅ Correct - explicit Output enables testing and proper typing
export default pattern<TodoInput, TodoOutput>(({ items }) => {
  const addItem = addItemHandler({ items });
  return { items, addItem };
});

// ❌ Avoid - actions aren't typed, can't test via .send()
export default pattern<TodoInput>(({ items }) => {
  const addItem = addItemHandler({ items });
  return { items, addItem };  // addItem type is unknown
});
```

**Why this matters:**
- **Testing requires Output types** - To test via `instance.action.send()`, actions must be typed as `Stream<T>` in the Output interface
- **Sub-patterns require `[UI]` in Output** - When rendering a sub-pattern via `.map()`, the Output type must include `[UI]: VNode`
- **TypeScript verification** - Explicit Output types catch mismatches at compile time

### Output Types for Sub-Patterns

When a pattern will be rendered inside another pattern (e.g., Column inside Board), include `[NAME]` and `[UI]` in the Output type:

```typescript
import { NAME, UI, VNode, Stream } from "commonfabric";

interface ColumnOutput {
  [NAME]: string;
  [UI]: VNode;
  cardCount: number;
  addCard: Stream<{ title: string }>;
}
```

## See Also

- [Pattern Composition](../patterns/composition.md) - How sub-pattern rendering works
- [Writable](./types-and-schemas/writable.md) - Write intent in type signatures
- [Self-Reference](./self-reference.md) - For accessing a reference to the pattern instance itself
