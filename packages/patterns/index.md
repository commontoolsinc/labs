# Common Patterns

Prefix the URLs with
`https://raw.githubusercontent.com/commontoolsinc/labs/refs/heads/main/packages/patterns/`

## `counter.tsx`

A simple counter demo.

### Input Schema

```ts
interface CounterInput {
  value: number;
}
```

### Result Schema

```ts
interface CounterOutput {
  value?: number;
  increment: Stream<void>;
  decrement: Stream<void>;
}
```

## `todo-list.tsx`

A todo list with AI suggestions.

### Input Schema

```ts
interface Input {}
```

### Result Schema

```ts
interface TodoItem {
  title: string;
  done: Default<boolean, false>;
}

interface Output {
  items: Cell<TodoItem[]>;
}
```

## `note.tsx`

A note demo.

### Input Schema

```ts
type NoteInput = {
  /** The title of the note */
  title: string;
  /** The content of the note */
  content: string;
};
```

### Result Schema

```ts
type NoteOutput = {
  /** The content of the note */
  content: string;
  grep: Stream<{ query: string }>;
  translate: Stream<{ language: string }>;
  editContent: Stream<{ detail: { value: string } }>;
};
```
