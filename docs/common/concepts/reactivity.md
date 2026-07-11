# Reactivity and Write Access

## How Reactivity Works

Everything a pattern receives as input or derives with `computed()` is
reactive: when a value changes, everything that reads it updates
automatically. JSX references subscribe automatically — `{count}` re-renders
when `count` changes, with no wrapper needed. Inside `computed()`, `lift()`,
`action()`, and `handler()` bodies, read current values with `.get()`; those
reads are tracked as dependencies (in computed/lift). Derive data with
[computed()](./computed/computed.md) and gate UI with plain ternaries
([Conditional Rendering](../patterns/conditional.md)).

## Availability Is Reactive Control Flow

Single-result fetch and generation calls produce an `AsyncResult<T>`. Keep the
request when code needs to inspect loading or failure, and derive the ordinary
usable value with the zero-node `resultOf()` projection:

```tsx
// Shown for illustration only.
const repoRequest = fetchJson<Repo>({ url });
const repo = resultOf(repoRequest);
const title = computed(() => `${repo.owner}/${repo.name}`);

return isPending(repoRequest)
  ? <div>Loading…</div>
  : hasError(repoRequest)
    ? <div>{repoRequest.error.message}</div>
    : <h1>{title}</h1>;
```

While `repoRequest` is unavailable, computations which only consume `repo` do
not run; the same unavailable state propagates through their outputs. Once the
request contains a `Repo`, those computations resume with the non-optional
usable type. Guards opt only their own computation boundary into the reasons
they test, so code can render an error while continuing to wait through other
states. See [Fetching Data](../capabilities/fetch.md) and
[LLM Generation](../capabilities/llm.md) for the complete APIs.

## Core Principle: Writable<> is About Write Access, Not Reactivity

**The most important thing to understand:** Everything in Common Fabric is reactive by default. The `Writable<>` wrapper in type signatures doesn't enable reactivity—it indicates **write intent**.

### The Rule

- **Use `Writable<T>`** in signatures ONLY when you need write access (`.set()`, `.update()`, `.push()`, `.key()`)
- **Omit `Writable<>`** for read-only access - the framework automatically provides reactive values

```tsx
// Shown for illustration only.
import { action, Default, Writable, UI, pattern } from 'commonfabric'

interface Item {}

// ✅ Read-only - No Writable<> needed (still reactive!)
interface ReadOnlyInput {
  count: number | Default<0>;         // Just display it (defaults to 0)
  items: Item[];                     // Just map/display
  userName: string;                  // Just show it
}

export const ReadOnly = pattern<ReadOnlyInput>(({ count, items, userName }) => {
  return {
    [UI]: (
      <div>
        <div>Count: {count}</div>              {/* Reactive! */}
        <div>User: {userName}</div>            {/* Reactive! */}
        {items.map(item => <div>{item}</div>)} {/* Reactive! */}
      </div>
    ),
  };
});

// ✅ Write access - Writable<> required
interface WritableInput {
  count: Writable<number | Default<0>>;  // Will call count.set()
  items: Writable<Item[]>;              // Will call items.push()
  title: Writable<string>;              // Will call title.set()
}

export default pattern<WritableInput>(({ count, items, title }) => {
  // action() closes over pattern state - the preferred way to mutate
  const increment = action(() => {
    count.set(count.get() + 1);
  });

  const addItem = action(() => {
    items.push({ title: "New" });
  });

  return {
    [UI]: (
      <div>
        {/* Display is still reactive */}
        <div>Count: {count}</div>

        {/* Can also mutate */}
        <cf-button onClick={increment}>Increment</cf-button>

        {/* Bidirectional binding */}
        <cf-input $value={title} />

        {/* Can also mutate */}
        <cf-button onClick={addItem}>Add Item</cf-button>
      </div>
    ),
  };
});
```

## Results Mirror the Rule: Writable<> in a Result Type Grants Write Access

The same principle applies to what a pattern (or `lift`/`computed`) **returns**.
Cell brands in a result type are exported capabilities, and they are preserved
end-to-end: the brand in the type becomes `asCell` in the generated result
schema, and consumers receive a live `Cell` — same identity, write access
included — not a dereferenced copy.

- **Include `Writable<T>`/`Cell<T>` in a result field** when you intend
  consumers to write to it (or bind it bidirectionally, e.g. `$value`).
- **Omit it** when consumers should only read — return the plain value
  (it's still reactive, as always).

```tsx
// Shown at module scope.
interface CounterOutput {
  count: Writable<number>;   // consumers may .set() / bind $value
  label: string;             // read-only view (still reactive)
}
```

**Export your result type.** Because the factory's result type references your
declared interface by name (`pattern<Input, Output>` produces a
`PatternFactory<…, Output>`), a non-exported `Output` interface fails
compilation with "Default export of the module has or is using private name
'Output'". The result type is your public contract — export it:

```tsx
// Shown for illustration only.
export interface CounterOutput { /* ... */ }
export default pattern<CounterInput, CounterOutput>(/* ... */);
```

Consumers see exactly what the author returned — the factory's result type is
not stripped. A consumer that receives `Writable<GameState>` reads current
values with `.get()` inside `computed()`/`lift()`/handler bodies, just like a
`Writable<>` input:

```tsx
// Shown inside a pattern body.
const game = Battleship({});
const phase = computed(() => game.game.get().phase); // game.game: Writable<GameState>
```
