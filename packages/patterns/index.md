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

## `gpa-stats-source.tsx`

Source charm for charm linking example. Computes statistics from GPA data and exposes them for other charms to consume.

**Keywords:** charm-linking, source, lift, computed-stats

### Input Schema

```ts
interface Input {
  name: Default<string, "gpa-source-v1">;
  rawData: Default<string, "">;
}
```

### Output Schema

```ts
interface Stats {
  average: number;
  count: number;
  min: number;
  max: number;
}

interface Output {
  name: string;
  rawData: string;
  gpaStats: Stats | null;  // Exposed for linking
}
```

## `gpa-stats-reader.tsx`

Consumer charm for charm linking example. Receives linked statistics from gpa-stats-source and displays them.

**Keywords:** charm-linking, consumer, Default-null

### Input Schema

```ts
interface Stats {
  average: number;
  count: number;
  min: number;
  max: number;
}

interface Input {
  name: Default<string, "gpa-reader-v1">;
  gpaStats: Default<Stats | null, null>;  // null until linked
}
```
