# Patterns

A pattern is a TypeScript/JSX program that defines reactive data transformations with an optional UI. You instantiate a pattern by binding it to specific cells.

```mermaid
flowchart TD
        A["Result Cell"]
        A --source--> B["Process Cell"]
        B --value.resultRef--> A
        B --value.pattern--> C["Pattern Cell"]
        D@{ shape: procs, label: "Input Cells"} --source--> B
```

## Input and Output Types

Explicitly define types for your pattern inputs and outputs.

The type declares what data it expects and _how_ it is accessed.

```typescript
interface TodoInput {
  items?: Writable<Default<Todo[], []>>;
  title?: Writable<Default<string, "untitled">>;
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

Input types describe what the pattern receives when instantiated. Use `Writable<>` for state the pattern intends to modify:

```typescript
interface MyInput {
  count: Writable<number>;     // Pattern will call .set() or .update()
  items: Writable<Item[]>;     // Pattern will call .push() or .set()
  label: string;               // Read-only (still reactive!)
}
```

**Guideline:**

- Use `Writable<>` when you want to call .set(), .push(), .update(), etc on it. Use plain types otherwise. It's explicitly ok to pass a plain type to a pattern that requests Writable<>, the framework will handle write intent transparently.
- Add `Default<Type, Value>` with a reasonable initial state for most inputs, unless it really makes no sense to use the pattern without that value being passed in.

### Output Types

Output types describe what the pattern returns. They should exactly mirror the return object without additional wrapping:

```typescript
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
import { NAME, UI, VNode, Stream } from "commontools";

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
