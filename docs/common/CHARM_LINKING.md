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
import { Cell, Default, NAME, recipe, UI, lift } from "commontools";

// Data structure to expose
interface Stats {
  average: number;
  q1: number;
  median: number;
  q3: number;
  iqr: number;
  count: number;
}

// Input: what this charm accepts
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
const calculateStats = lift((values: number[]): Stats | null => {
  if (values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((acc, val) => acc + val, 0);
  const average = sum / n;

  // Quartile calculations...
  const q1 = percentile(sorted, 25);
  const median = percentile(sorted, 50);
  const q3 = percentile(sorted, 75);
  const iqr = q3 - q1;

  return { average, q1, median, q3, iqr, count: n };
});

export default recipe<Input, Output>(
  "Stats Calculator",
  ({ name, rawData }) => {
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
  }
);
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
import { Default, NAME, recipe, UI, lift } from "commontools";

// Must match the source charm's exposed structure
interface Stats {
  average: number;
  q1: number;
  median: number;
  q3: number;
  iqr: number;
  count: number;
}

// Input declares optional linked fields with Default<T, null>
interface Input {
  name: Default<string, "stats-reader-v1">;
  linkedStats: Default<Stats | null, null>;  // null until linked
}
```

### Step 2: Handle Both Linked and Unlinked States

```typescript
// Helper functions handle null gracefully
const hasData = lift((s: Stats | null) => s !== null);
const getAverage = lift((s: Stats | null) => s?.average);
const formatNumber = lift((val: number | undefined) =>
  val !== undefined ? val.toFixed(2) : "—"
);

export default recipe<Input, Input>(
  "Stats Reader",
  ({ name, linkedStats }) => {
    const dataPresent = hasData(linkedStats);

    return {
      [NAME]: "Stats Reader",
      [UI]: (
        <div>
          <h2>Stats Reader</h2>

          {/* Always show something meaningful */}
          <div>
            <p><strong>Average:</strong> {formatNumber(getAverage(linkedStats))}</p>
            <p><strong>Count:</strong> {linkedStats?.count ?? 0}</p>
          </div>

          <p style={{ fontSize: "12px", color: "#666" }}>
            Link this charm to a stats source using ct charm link.
          </p>
        </div>
      ),
      name,
      linkedStats,
    };
  }
);
```

### Key Rules for Consumer Charms

1. **Use `Default<T, null>` for linked fields** - provides fallback when unlinked
2. **Interface must match source** - the Stats interface must be identical
3. **Use `lift()` for null-safe access** - `lift((s) => s?.field)` handles null gracefully
4. **Show helpful UI when unlinked** - guide users on how to link

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

### Source Charm: `gpa-stats-source.tsx`

```typescript
/// <cts-enable />
import { Cell, Default, NAME, recipe, UI, lift, handler } from "commontools";

interface Stats {
  average: number;
  count: number;
  min: number;
  max: number;
}

interface Input {
  name: Default<string, "gpa-source-v1">;
  rawData: Default<string, "">;
}

interface Output {
  name: string;
  rawData: string;
  gpaStats: Stats | null;
}

const parseGpas = lift((raw: string): number[] => {
  if (!raw.trim()) return [];
  return raw.split("\n")
    .map(line => parseFloat(line.trim()))
    .filter(n => !isNaN(n));
});

const calculateStats = lift((values: number[]): Stats | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    average: sum / sorted.length,
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
});

const updateData = handler<
  { target: { value: string } },
  { rawData: Cell<string> }
>((event, { rawData }) => {
  rawData.set(event.target.value);
});

export default recipe<Input, Output>(
  "GPA Stats Source",
  ({ name, rawData }) => {
    const gpas = parseGpas(rawData);
    const gpaStats = calculateStats(gpas);

    return {
      [NAME]: "GPA Source",
      [UI]: (
        <div style={{ padding: "16px" }}>
          <h2>GPA Data Entry</h2>
          <textarea
            value={rawData}
            onChange={updateData({ rawData })}
            placeholder="Enter GPAs, one per line..."
            rows={8}
            style={{ width: "100%", fontFamily: "monospace" }}
          />
        </div>
      ),
      name,
      rawData,
      gpaStats,  // Exposed for linking
    };
  }
);
```

### Consumer Charm: `gpa-stats-reader.tsx`

```typescript
/// <cts-enable />
import { Default, NAME, recipe, UI, lift } from "commontools";

interface Stats {
  average: number;
  count: number;
  min: number;
  max: number;
}

interface Input {
  name: Default<string, "gpa-reader-v1">;
  gpaStats: Default<Stats | null, null>;
}

const fmt = lift((n: number | undefined) =>
  n !== undefined ? n.toFixed(2) : "—"
);
const getAvg = lift((s: Stats | null) => s?.average);
const getMin = lift((s: Stats | null) => s?.min);
const getMax = lift((s: Stats | null) => s?.max);
const getCount = lift((s: Stats | null) => s?.count ?? 0);

export default recipe<Input, Input>(
  "GPA Stats Reader",
  ({ name, gpaStats }) => {
    return {
      [NAME]: "GPA Reader",
      [UI]: (
        <div style={{ padding: "16px", background: "#f0f8ff" }}>
          <h2>GPA Statistics (Linked)</h2>
          <table>
            <tbody>
              <tr>
                <td><strong>Count:</strong></td>
                <td>{getCount(gpaStats)}</td>
              </tr>
              <tr>
                <td><strong>Average:</strong></td>
                <td>{fmt(getAvg(gpaStats))}</td>
              </tr>
              <tr>
                <td><strong>Min:</strong></td>
                <td>{fmt(getMin(gpaStats))}</td>
              </tr>
              <tr>
                <td><strong>Max:</strong></td>
                <td>{fmt(getMax(gpaStats))}</td>
              </tr>
            </tbody>
          </table>
          <p style={{ fontSize: "12px", color: "#666", marginTop: "16px" }}>
            Data updates automatically when source changes.
          </p>
        </div>
      ),
      name,
      gpaStats,
    };
  }
);
```

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
- [ ] Type recipe as `recipe<Input, Output>`

### Consumer Charm Checklist
- [ ] Use `Default<T, null>` for linked input fields
- [ ] Match the interface structure exactly
- [ ] Use `lift()` helpers for null-safe access
- [ ] Handle unlinked state gracefully in UI

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
