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

Explicitly define types for your pattern inputs and outputs. This makes your code clearer and helps catch errors early.

```typescript
interface TodoInput {
  items: Writable<Todo[]>;
  title: Writable<string>;
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

**Guideline:** Most inputs should be `Writable<>` since patterns typically modify their state. Use plain types only for truly read-only data.

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

### Type Inference

You can omit type parameters and let TypeScript infer them:

```typescript
// Inferred types - acceptable for simple patterns
export default pattern(({ count, items }) => {
  return { count, items };
});
```

However, explicit types are recommended because they:
- Document intent clearly
- Catch type mismatches at compile time
- Make the pattern's contract visible in `schemas.tsx`

### When to Use Dual Type Parameters

Use `pattern<Input, Output>()` when:
- Input and output shapes differ (transformation patterns)
- You need `SELF` reference (see [Self-Reference](./self-reference.md))
- You want explicit documentation of the pattern's contract

Use `pattern<State>()` to infer the output type or `pattern<>()` to infer both types when you're prototyping and will add explicit types later.

## See Also

- [Writable](./types-and-schemas/writable.md) - Write intent in type signatures
- [Self-Reference](./self-reference.md) - Using `SELF` with dual type parameters
