<!-- @reviewed 2025-12-10 docs-rationalization -->

# Charm Linking Guide for CommonTools Patterns

## Overview

Charm linking enables reactive data sharing between independently deployed patterns. When you link a source charm's output field to a consumer charm's input field, changes in the source automatically propagate to the consumer.

**Key Concepts:**
- **Source Charm**: Exposes data in its Output interface
- **Consumer Charm**: Receives data through its Input interface
- **Link**: A reactive cell reference connecting source output → consumer input
- **Reactivity**: Updates flow automatically - no polling or manual sync needed

---

## Part 1: Creating a Source Charm (Data Provider)

A source charm exposes data for other charms to consume by including fields in its **Output interface** and **return object**.

### Step 1: Define Separate Input and Output Interfaces

```typescript
/// <cts-enable />
import { Cell, Default, NAME, pattern, UI, lift } from "commontools";

// Data structure to expose
interface Stats {
  average: number;
  q1: number;
  median: number;
  q3: number;
  iqr: number;
  count: number;
}

/** Stats Calculator */
interface Input {
  name: Default<string, "my-stats-v1">;
  rawData: Default<string, "">;
}

// Output: what this charm exposes for linking
interface Output {
  name: string;
  rawData: string;
  computedStats: Stats | null;  // <-- Exposed for other charms
}
```

### Step 2: Compute and Return the Exposed Data

```typescript
// Parse raw data into numbers
const parseData = lift((raw: string): number[] => {
  if (!raw.trim()) return [];
  return raw.split("\n")
    .map(line => parseFloat(line.trim()))
    .filter(n => !isNaN(n));
});

const calculateStats = lift((values: number[]): Stats | null => {
  if (values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((acc, val) => acc + val, 0);
  const average = sum / n;

  // Quartile calculation helper
  const percentile = (p: number): number => {
    const index = (p / 100) * (n - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + (index - lower) * (sorted[upper] - sorted[lower]);
  };

  const q1 = percentile(25);
  const median = percentile(50);
  const q3 = percentile(75);
  const iqr = q3 - q1;

  return { average, q1, median, q3, iqr, count: n };
});

export default pattern<Input, Output>(({ name, rawData }) => {
  // Compute derived values
  const parsedValues = parseData(rawData);
  const computedStats = calculateStats(parsedValues);

  return {
    [NAME]: "Stats Calculator",
    [UI]: (/* your UI here */),

    // These fields are exposed for linking:
    name,
    rawData,
    computedStats,  // <-- Other charms can link to this
  };
});
```

### Key Rules for Source Charms

1. **Every field in the return object is linkable** - include what you want to expose
2. **Use `lift()` for computed values** - ensures reactivity
3. **Type the Output interface explicitly** - documents your charm's API
4. **Nested fields are accessible** - `charmId/computedStats/average` works

---

## Part 2: Creating a Consumer Charm (Data Receiver)

A consumer charm declares expected linked data using `Default<T, null>` in its Input interface.

### Step 1: Define Input with Optional Linked Fields

```typescript
/// <cts-enable />
import { Default, NAME, pattern, UI, lift } from "commontools";
// You can import the Stats type from the source charm:
// import type { Stats } from "./stats-source.tsx";

// Or define it locally (must match the source charm's structure)
interface Stats {
  average: number;
  q1: number;
  median: number;
  q3: number;
  iqr: number;
  count: number;
}

/** Stats Reader */
interface Input {
  name: Default<string, "stats-reader-v1">;
  linkedStats: Default<Stats | null, null>;  // null until linked
}
```

### Step 2: Use Linked Data in Your Pattern

```typescript
const formatNumber = lift((val: number | undefined) =>
  val !== undefined ? val.toFixed(2) : "—"
);

export default pattern<Input, Input>(({ name, linkedStats }) => {
  return {
    [NAME]: "Stats Reader",
    [UI]: (
      <div>
        <h2>Stats Reader</h2>
        <div>
          <p><strong>Average:</strong> {formatNumber(linkedStats?.average)}</p>
          <p><strong>Count:</strong> {linkedStats?.count ?? 0}</p>
        </div>
      </div>
    ),
    name,
    linkedStats,
  };
});
```

### Key Rules for Consumer Charms

1. **Use `Default<T, null>` for linked fields** - provides fallback when unlinked
2. **Interface must match source** - the Stats interface must be identical

---

## Part 3: Deploying and Linking Charms

### Step 1: Deploy Both Charms to the Same Space

```bash
# Deploy source charm
deno task ct charm new \
  --identity ~/labs/tony.key \
  --api-url http://localhost:8000 \
  --space myspace \
  packages/patterns/stats-source.tsx
# Returns: baedreiAAA...

# Deploy consumer charm
deno task ct charm new \
  --identity ~/labs/tony.key \
  --api-url http://localhost:8000 \
  --space myspace \
  packages/patterns/stats-reader.tsx
# Returns: baedreiBBB...
```

### Step 2: Link the Fields

```bash
# Syntax: ct charm link <source>/<field> <target>/<field>
deno task ct charm link \
  --identity ~/labs/tony.key \
  --api-url http://localhost:8000 \
  --space myspace \
  baedreiAAA.../computedStats \
  baedreiBBB.../linkedStats
```

### Step 3: Access in Browser

```
http://localhost:8000/myspace
```

Both charms appear in the space. Changes to the source charm's data automatically update in the consumer charm.

---

## Part 4: Complete Working Example

Working examples are available in the patterns directory:

- **Source Charm**: [`packages/patterns/gpa-stats-source.tsx`](../../packages/patterns/gpa-stats-source.tsx)
- **Consumer Charm**: [`packages/patterns/gpa-stats-reader.tsx`](../../packages/patterns/gpa-stats-reader.tsx)

These patterns demonstrate:
- Source charm exposing computed `gpaStats` for linking
- Consumer charm receiving linked data via `Default<Stats | null, null>`
- Reactive updates flowing automatically when source data changes

### Deployment Script

```bash
#!/bin/bash
IDENTITY=~/labs/tony.key
API_URL=http://localhost:8000
SPACE=gpa-demo

# Deploy source
SOURCE_ID=$(deno task ct charm new \
  --identity $IDENTITY \
  --api-url $API_URL \
  --space $SPACE \
  packages/patterns/gpa-stats-source.tsx 2>&1 | tail -1)

echo "Source charm: $SOURCE_ID"

# Deploy reader
READER_ID=$(deno task ct charm new \
  --identity $IDENTITY \
  --api-url $API_URL \
  --space $SPACE \
  packages/patterns/gpa-stats-reader.tsx 2>&1 | tail -1)

echo "Reader charm: $READER_ID"

# Link them
deno task ct charm link \
  --identity $IDENTITY \
  --api-url $API_URL \
  --space $SPACE \
  "$SOURCE_ID/gpaStats" \
  "$READER_ID/gpaStats"

echo "Linked! Open: http://localhost:8000/$SPACE"
```

---

## Quick Reference

### Source Charm Checklist
- [ ] Define `Output` interface with fields to expose
- [ ] Use `lift()` for all computed values
- [ ] Include exposed fields in return object
- [ ] Type pattern as `pattern<Input, Output>`
- [ ] Add JSDoc comment above Input for the charm title

### Consumer Charm Checklist
- [ ] Use `Default<T, null>` for linked input fields
- [ ] Match the interface structure exactly (or import the type from the source)

### CLI Commands
```bash
# Deploy charm
deno task ct charm new --identity KEY --api-url URL --space SPACE file.tsx

# Link charms
deno task ct charm link --identity KEY --api-url URL --space SPACE \
  SOURCE_ID/field TARGET_ID/field

# Inspect charm
deno task ct charm inspect --identity KEY --api-url URL --space SPACE CHARM_ID
```

### Common Patterns

| Pattern | Source Output | Consumer Input |
|---------|--------------|----------------|
| Simple value | `count: number` | `count: Default<number, 0>` |
| Nullable object | `stats: Stats \| null` | `stats: Default<Stats \| null, null>` |
| Array | `items: Item[]` | `items: Default<Item[], []>` |
| Nested access | `data.users[0].name` | Link path: `charmId/data/users/0/name` |

---

## How It Works Under the Hood

1. **Link Creation**: `ct charm link` creates a cell alias from target input → source output
2. **Cell Reference**: Target's input field becomes a reference to source's output cell
3. **Reactivity**: When source recomputes, the cell updates, triggering target's recomputation
4. **UI Update**: Target pattern re-renders with new data automatically

No polling. No manual refresh. Pure reactive data flow.

---

## Cross-Charm Communication via wish()

For dynamic charm discovery (rather than explicit linking), use the `wish()` function to find charms by tag.

### Prerequisites for wish()

1. **Tags in JSDoc on Output type**: Tags like `#mytag` must appear in a JSDoc comment directly on the Output interface:

```typescript
/** A #note charm for storing text */
interface Output {
  content: string;
  editContent: Stream<{ value: string }>;
}
```

2. **Charm must be favorited**: `wish({ query: "#tag" })` searches the favorites list, not all charms in the space. The target charm must be favorited first.

### Invoking Streams on Wished Charms

When you wish for a charm that exposes a Stream, the stream arrives as a Cell wrapping a `{ $stream: true }` marker. To invoke it:

```typescript
const wishResult = wish<{ editContent: Stream<void> }>({ query: "#note" });

// In a handler
const invokeStream = handler<unknown, { stream: Stream<void> }>(
  (_event, state) => {
    const streamCell = state.stream as any;
    const inner = streamCell.get();
    if (inner && inner.$stream) {
      streamCell.send({});  // Call .send() on the Cell itself
    }
  }
);
```

**Event data requirements:**
- Must be an object (runtime calls `event.preventDefault()`)
- Can include data properties: `streamCell.send({ key: "value" })`
- Cannot include functions (fails serialization)

### Forcing Wished Charms to Execute

Wished charms are referenced but not active until rendered. Use `<ct-render>` to force execution:

```typescript
const wishResult = wish<{ content: string }>({ query: "#note" });

// This forces the wished charm to execute and respond to stream invocations
{wishResult.result && <ct-render $cell={wishResult.result} />}
```

Without rendering, the charm won't respond to stream invocations.

See `packages/patterns/blessed-verification/test-cross-charm-*.tsx` for working examples.
