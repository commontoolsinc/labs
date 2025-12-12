<!-- @reviewed 2025-12-11 docs-rationalization -->

# Charm Linking

Reactive data sharing between independently deployed patterns.

## Concepts

- **Source Charm**: Exposes data in its Output interface
- **Consumer Charm**: Receives data through Input with `Default<T, null>`
- **Link**: Reactive cell reference (source output → consumer input)
- Updates flow automatically - no polling needed

---

## Source Charm (Data Provider)

Include fields in Output interface and return object:

```typescript
/// <cts-enable />
import { Default, NAME, pattern, UI, lift } from "commontools";

interface Stats { average: number; count: number; }

/** Stats Calculator */
interface Input {
  rawData: Default<string, "">;
}

interface Output {
  rawData: string;
  computedStats: Stats | null;  // Exposed for linking
}

const calculateStats = lift((raw: string): Stats | null => {
  const values = raw.split("\n").map(Number).filter(n => !isNaN(n));
  if (!values.length) return null;
  return { average: values.reduce((a, b) => a + b) / values.length, count: values.length };
});

export default pattern<Input, Output>(({ rawData }) => ({
  [NAME]: "Stats Calculator",
  [UI]: <div>...</div>,
  rawData,
  computedStats: calculateStats(rawData),  // Other charms link to this
}));
```

**Rules:**
- Every return field is linkable
- Use `lift()` for computed values
- Nested paths work: `charmId/computedStats/average`

---

## Consumer Charm (Data Receiver)

Use `Default<T, null>` for linked fields:

```typescript
/// <cts-enable />
import { Default, NAME, pattern, UI, lift } from "commontools";

interface Stats { average: number; count: number; }

/** Stats Reader */
interface Input {
  linkedStats: Default<Stats | null, null>;  // null until linked
}

const format = lift((val: number | undefined) => val?.toFixed(2) ?? "—");

export default pattern<Input, Input>(({ linkedStats }) => ({
  [NAME]: "Stats Reader",
  [UI]: (
    <div>
      <p>Average: {format(linkedStats?.average)}</p>
      <p>Count: {linkedStats?.count ?? 0}</p>
    </div>
  ),
  linkedStats,
}));
```

**Rules:**
- Use `Default<T, null>` for graceful unlinked state
- Interface must match source exactly

---

## Linking Commands

```bash
# Deploy both charms
deno task ct charm new -i KEY -a URL -s SPACE source.tsx  # → SOURCE_ID
deno task ct charm new -i KEY -a URL -s SPACE reader.tsx  # → TARGET_ID

# Link: source/field → target/field
deno task ct charm link -i KEY -a URL -s SPACE \
  SOURCE_ID/computedStats TARGET_ID/linkedStats
```

Use `deno task ct charm link --help` for full options.

---

## Common Patterns

| Pattern | Source Output | Consumer Input |
|---------|--------------|----------------|
| Simple value | `count: number` | `count: Default<number, 0>` |
| Nullable object | `stats: Stats \| null` | `stats: Default<Stats \| null, null>` |
| Array | `items: Item[]` | `items: Default<Item[], []>` |
| Nested path | — | `charmId/data/users/0/name` |

---

## Working Examples

- [`packages/patterns/gpa-stats-source.tsx`](../../packages/patterns/gpa-stats-source.tsx)
- [`packages/patterns/gpa-stats-reader.tsx`](../../packages/patterns/gpa-stats-reader.tsx)

---

## Dynamic Discovery via wish()

Find charms by tag instead of explicit linking:

```typescript
/** A #note charm for storing text */
interface Output {
  content: string;
  editContent: Stream<{ value: string }>;
}

// Find charm by tag (must be favorited first)
const wishResult = wish<{ content: string; editContent: Stream<void> }>({ query: "#note" });

// Force execution with ct-render
{wishResult.result && <ct-render $cell={wishResult.result} />}
```

**Requirements:**
- Tags (`#mytag`) in JSDoc on Output interface
- Target charm must be favorited (`wish()` searches favorites only)
- Render wished charm with `<ct-render>` to activate it

**Invoking Streams:**
```typescript
const invokeStream = handler<unknown, { stream: Stream<void> }>(
  (_, state) => {
    const streamCell = state.stream as any;
    if (streamCell.get()?.$stream) streamCell.send({});
  }
);
```

See `packages/patterns/blessed-verification/test-cross-charm-*.tsx` for examples.
