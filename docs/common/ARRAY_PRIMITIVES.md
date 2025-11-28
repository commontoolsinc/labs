# Array Primitives: Cell.reduce() and Keyed map()

Two extensions to standard Cell array operations for advanced reactive scenarios.

| Method | Purpose | When to Use |
|--------|---------|-------------|
| `cell.reduce()` | Aggregate array values | Counting, summing, collecting completed results |
| `cell.map(fn, { key })` | Map with stable identity | Processing where array order may change |

---

## Cell.reduce() - Reactive Array Reduction

Aggregates an array cell into a single value, re-computing when any element changes.

### Basic Usage

```typescript
import { Cell, recipe } from "commontools";

interface State {
  numbers: Cell<number[]>;
}

export default recipe<State>("Sum Example", ({ numbers }) => {
  // Sum all numbers
  const sum = numbers.reduce(0, (acc, n) => acc + n);
  // Result: 15 for [1, 2, 3, 4, 5]

  // Count items
  const count = numbers.reduce(0, (acc, _) => acc + 1);
  // Result: 5

  return { sum, count };
});
```

### Closure Capture

`reduce()` supports capturing values from outer scope:

```typescript
interface State {
  items: Cell<number[]>;
  multiplier: number;
}

export default recipe<State>("Scaled Sum", ({ items, multiplier }) => {
  // multiplier is captured - updates when either changes
  const scaledSum = items.reduce(
    0,
    (acc, item) => acc + item * multiplier
  );
  // Result: 120 for [10, 20, 30] with multiplier=2

  return { scaledSum };
});
```

### Real-World Example: Counting Unread Reports

```typescript
interface Report {
  id: string;
  title: string;
  isRead: boolean;
}

interface State {
  reports: Cell<Report[]>;
}

export default recipe<State>("Unread Counter", ({ reports }) => {
  // Reactively counts unread reports
  const unreadCount = reports.reduce(
    0,
    (acc: number, report: Report) => acc + (report.isRead ? 0 : 1)
  );

  return {
    [UI]: (
      <div>
        {unreadCount > 0 ? <span class="badge">{unreadCount} UNREAD</span> : null}
      </div>
    ),
  };
});
```

### When to Use reduce() vs computed()

| Use `reduce()` | Use `computed()` |
|----------------|------------------|
| Iterating over array elements | Simple property access |
| Need element values unwrapped | Don't need to iterate |
| Aggregating into new value | Deriving from single values |

```typescript
// ✅ reduce() - iterating over array
const total = items.reduce(0, (acc, item) => acc + item.price);

// ✅ computed() - simple derivation
const hasItems = computed(() => items.length > 0);
```

### Gotchas

1. **Reducer runs on EVERY change** - keep reducers fast
2. **Reducer must be pure** - no side effects
3. **Add explicit types** for TypeScript inference when needed

---

## Keyed map() - Key-Based Array Mapping

Maps over an array using stable keys instead of indices. Essential when array order may change.

### The Problem with Standard Cell.map()

```typescript
const urls = Cell.of(["a.com", "b.com"]);
const fetches = urls.map(url => fetchData({ url }));

// Later, array reorders:
urls.set(["b.com", "a.com"]);
// Standard map() thinks index 0 changed, re-fetches "b.com"!
```

### Solution: map() with { key } Option

```typescript
// Identity key (item value IS the key)
const fetches = urls.map(
  url => fetchData({ url }),
  { key: "." }  // Use item itself as key
);

urls.set(["b.com", "a.com"]);
// Same keys, no re-fetch. Just reorders results.
```

### Property Path Keys

For objects, use a property path to extract the key:

```typescript
interface Article { id: number; title: string; }

interface State {
  articles: Cell<Article[]>;
}

export default recipe<State>("Article Analyzer", ({ articles }) => {
  // Key by "id" property
  const analyses = articles.map(
    (article) => generateObject({ prompt: article.title }),
    { key: "id" }  // Use article.id as stable key
  );

  return { analyses };
});
```

### Nested Property Paths

```typescript
interface Item {
  meta: { id: string; };
  content: string;
}

interface State {
  items: Cell<Item[]>;
}

export default recipe<State>("Item Processor", ({ items }) => {
  // Key by nested property
  const processed = items.map(
    (item) => process(item.content),
    { key: ["meta", "id"] }  // Array path for nested access
  );

  return { processed };
});
```

### Key Functions (Type-Checked)

For type-safe key extraction, use a key function instead of a string path:

```typescript
interface Item {
  id: number;
  category: { name: string };
  content: string;
}

interface State {
  items: Cell<Item[]>;
}

export default recipe<State>("Item Processor", ({ items }) => {
  // Key function - TypeScript validates the property exists
  const processed = items.map(
    (item) => process(item.content),
    { key: (item) => item.id }  // Compiles to { key: "id" }
  );

  // Nested property access works too
  const byCategory = items.map(
    (item) => process(item.content),
    { key: (item) => item.category.name }  // Compiles to { key: ["category", "name"] }
  );

  return { processed, byCategory };
});
```

**Benefits of key functions:**
- TypeScript checks that the property path is valid
- IDE autocomplete works
- Refactoring-safe (renaming properties updates the key)

**Note:** Only simple property access is supported. Complex expressions like
`item => item.type + ":" + item.id` will fail at compile time with a helpful error.

### Closure Capture

Keyed map callbacks can capture outer scope values:

```typescript
interface Item { id: number; price: number; }

interface State {
  items: Cell<Item[]>;
  discount: number;
}

export default recipe<State>("Discounted Items", ({ items, discount }) => {
  const discounted = items.map(
    (item) => ({
      id: item.id,
      finalPrice: item.price * discount  // discount captured!
    }),
    { key: "id" }
  );

  return { discounted };
});
```

### Real-World Example: Report Cards with Stable Identity

```typescript
interface Report { id: string; title: string; isRead: boolean; }

interface State {
  reports: Cell<Report[]>;
}

export default recipe<State>("Report List", ({ reports }) => {
  return {
    [UI]: (
      <div>
        {/* Each report gets stable identity by ID */}
        {/* Reordering reports won't cause re-renders of unchanged cards */}
        {reports.map(
          (report) => (
            <div style={{ background: report.isRead ? "white" : "lightblue" }}>
              <h3>{report.title}</h3>
              <ct-button onClick={() => toggleRead(report.id)}>
                {report.isRead ? "Mark Unread" : "Mark Read"}
              </ct-button>
            </div>
          ),
          { key: "id" }
        )}
      </div>
    ),
  };
});
```

### When to Use Keyed map() vs Standard map()

| Use `map(fn, { key })` | Use `map(fn)` |
|------------------------|---------------|
| Array may reorder | Append-only arrays |
| Items have stable IDs | Index-based identity OK |
| Expensive processing (LLM, API calls) | Simple transforms |
| Need deduplication by key | Duplicates are fine |

### API Summary

```typescript
// Standard map (index-based identity)
cell.map(callback)

// Keyed map (stable key-based identity)
cell.map(callback, { key: "propertyName" })         // Property as key
cell.map(callback, { key: ["nested", "prop"] })     // Nested property as key
cell.map(callback, { key: (item) => item.id })      // Key function (type-checked)
cell.map(callback, { key: (item) => item.a.b })     // Nested key function
```

### Gotchas

1. **Keys must be JSON-serializable** - strings, numbers, not objects/functions
2. **Duplicate keys are deduplicated** - first occurrence wins
3. **Avoid template literals with captured values** - use object properties instead

```typescript
// Template literal with captured value can cause issues
items.map((item) => `${prefix}-${item.name}`, { key: "id" });

// Safer: use object property or string concatenation
items.map(
  (item) => ({ formatted: prefix + "-" + item.name }),
  { key: "id" }
);
```

---

## Combining reduce() and Keyed map()

For streaming pipelines, combine both primitives:

```typescript
interface State {
  articleURLs: Cell<string[]>;
}

export default recipe<State>("Article Pipeline", ({ articleURLs }) => {
  // Step 1: Process each article (keyed by URL - no duplicates, stable identity)
  const analyses = articleURLs.map(
    (url) => generateObject({ prompt: fetchContent(url) }),
    { key: "." }  // URL itself is the key
  );

  // Step 2: Count completed analyses
  const completedCount = analyses.reduce(
    0,
    (acc, analysis) => acc + (analysis.pending ? 0 : 1)
  );

  // Step 3: Collect all links from completed analyses
  const allLinks = analyses.reduce(
    [] as string[],
    (acc, analysis) => {
      if (analysis.pending) return acc;
      return [...acc, ...analysis.result.links];
    }
  );

  // Step 4: Process novel links (keyed - same URL won't be re-fetched)
  const linkedContent = allLinks.map(
    (link) => fetchContent(link),
    { key: "." }
  );

  return { analyses, completedCount, allLinks, linkedContent };
});
```

### Why This Works

1. **Keyed map provides stable identity** - reordering doesn't cause re-processing
2. **reduce aggregates incrementally** - each completion updates the aggregate
3. **Keys flow through** - same URL = same cached result at every stage

---

## Quick Reference

```typescript
// reduce() - aggregate array cell into single value
cell.reduce(initialValue, (acc, item) => newAcc)
cell.reduce(initialValue, (acc, item, index) => newAcc)  // with index

// Keyed map() - map with stable key-based identity
cell.map(callback, { key: "propertyName" })           // property as key
cell.map(callback, { key: ["nested", "prop"] })       // nested property as key
cell.map(callback, { key: (item) => item.id })        // key function (type-checked)
cell.map(callback, { key: (item) => item.nested.id }) // nested key function
```

---

## Migration from Standalone Functions

If you were using the older standalone `reduce()` and `mapByKey()` functions:

```typescript
// Old API (deprecated)
import { reduce, mapByKey } from "commontools";
const sum = reduce(items, 0, (acc, n) => acc + n);
const mapped = mapByKey(items, "id", fn);

// New API (recommended)
const sum = items.reduce(0, (acc, n) => acc + n);
const mapped = items.map(fn, { key: "id" });
```

---

## See Also

- [CELLS_AND_REACTIVITY.md](CELLS_AND_REACTIVITY.md) - Core reactivity concepts
- [PATTERNS.md](PATTERNS.md) - Common pattern examples
