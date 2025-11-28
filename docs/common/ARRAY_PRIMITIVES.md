# Array Primitives: reduce() and mapByKey()

Two primitives for working with reactive arrays beyond `Cell.map()`.

| Primitive | Purpose | When to Use |
|-----------|---------|-------------|
| `reduce()` | Aggregate array values | Counting, summing, collecting completed results |
| `mapByKey()` | Map with stable identity | Processing where array order may change |

---

## reduce() - Reactive Array Reduction

Aggregates an array into a single value, re-computing when any element changes.

### Basic Usage

```typescript
import { reduce, cell } from "commontools";

const numbers = cell([1, 2, 3, 4, 5]);

// Sum all numbers
const sum = reduce(numbers, 0, (acc, n) => acc + n);
// Result: 15

// Count items
const count = reduce(numbers, 0, (acc, _) => acc + 1);
// Result: 5
```

### Closure Capture

reduce() supports capturing values from outer scope:

```typescript
const items = cell([10, 20, 30]);
const multiplier = cell(2);

// multiplier is captured - updates when either changes
const scaledSum = reduce(
  items,
  0,
  (acc, item) => acc + item * multiplier
);
// Result: 120 (10*2 + 20*2 + 30*2)
```

### Real-World Example: Counting Unread Reports

```typescript
interface Report {
  id: string;
  title: string;
  isRead: boolean;
}

const reports = cell<Report[]>([...]);

// Reactively counts unread reports
const unreadCount = reduce(
  reports,
  0,
  (acc: number, report: Report) => acc + (report.isRead ? 0 : 1)
);

// In UI:
{unreadCount > 0 ? <Badge>{unreadCount} UNREAD</Badge> : null}
```

### When to Use reduce() vs computed()

| Use `reduce()` | Use `computed()` |
|----------------|------------------|
| Iterating over array elements | Simple property access |
| Need element values unwrapped | Don't need to iterate |
| Aggregating into new value | Deriving from single values |

```typescript
// ✅ reduce() - iterating over array
const total = reduce(items, 0, (acc, item) => acc + item.price);

// ✅ computed() - simple derivation
const hasItems = computed(() => items.length > 0);
```

### Gotchas

1. **Reducer runs on EVERY change** - keep reducers fast
2. **Reducer must be pure** - no side effects
3. **Add explicit types** for TypeScript inference when needed

---

## mapByKey() - Key-Based Array Mapping

Maps over an array using stable keys instead of indices. Essential when array order may change.

### The Problem with Cell.map()

```typescript
const urls = cell(["a.com", "b.com"]);
const fetches = urls.map(url => fetchData({ url }));

// Later, array reorders:
urls.set(["b.com", "a.com"]);
// Cell.map() thinks index 0 changed, re-fetches "b.com"!
```

### Solution: mapByKey()

```typescript
import { mapByKey } from "commontools";

// Identity key (item value IS the key)
const fetches = mapByKey(urls, url => fetchData({ url }));

urls.set(["b.com", "a.com"]);
// Same keys, no re-fetch. Just reorders results.
```

### Property Path Keys

For objects, use a property path to extract the key:

```typescript
interface Article { id: number; title: string; }

const articles = cell<Article[]>([...]);

// Key by "id" property
const analyses = mapByKey(
  articles,
  "id",  // Property path
  (article) => generateObject({ prompt: article.title })
);
```

### Nested Property Paths

```typescript
interface Item {
  meta: { id: string; };
  content: string;
}

// Key by nested property
const processed = mapByKey(
  items,
  ["meta", "id"],  // Array path for nested access
  (item) => process(item.content)
);
```

### Closure Capture

mapByKey() callbacks can capture outer scope values:

```typescript
const items = cell([{ id: 1, price: 10 }, { id: 2, price: 20 }]);
const discount = cell(0.9);

const discounted = mapByKey(
  items,
  "id",
  (item) => ({
    id: item.id,
    finalPrice: item.price * discount  // discount captured!
  })
);
```

### Real-World Example: Report Cards with Stable Identity

```typescript
interface Report { id: string; title: string; isRead: boolean; }

const reports = cell<Report[]>([...]);

// Each report gets stable identity by ID
// Reordering reports won't cause re-renders of unchanged cards
{mapByKey(reports, "id", (report) => (
  <ct-card style={{ background: report.isRead ? "white" : "lightblue" }}>
    <h3>{report.title}</h3>
    <ct-button onClick={() => toggleRead(report.id)}>
      {report.isRead ? "Mark Unread" : "Mark Read"}
    </ct-button>
  </ct-card>
))}
```

### When to Use mapByKey() vs Cell.map()

| Use `mapByKey()` | Use `Cell.map()` |
|------------------|------------------|
| Array may reorder | Append-only arrays |
| Items have stable IDs | Index-based identity OK |
| Expensive processing (LLM, API calls) | Simple transforms |
| Need deduplication by key | Duplicates are fine |

### API Summary

```typescript
// Identity key (item value is key)
mapByKey(list, callback)

// Property path key
mapByKey(list, "id", callback)
mapByKey(list, ["nested", "id"], callback)
```

### Gotchas

1. **Keys must be JSON-serializable** - strings, numbers, not objects/functions
2. **Duplicate keys are deduplicated** - first occurrence wins
3. **Avoid template literals with captured values** - use object properties instead

```typescript
// Template literal with captured value can cause issues
mapByKey(items, "id", (item) => `${prefix}-${item.name}`);

// Safer: use object property or string concatenation
mapByKey(items, "id", (item) => ({
  formatted: prefix + "-" + item.name
}));
```

---

## Combining reduce() and mapByKey()

For streaming pipelines, combine both primitives:

```typescript
// Step 1: Process each article (keyed by URL - no duplicates, stable identity)
const analyses = mapByKey(
  articleURLs,
  (url) => generateObject({ prompt: fetchContent(url) })
);

// Step 2: Count completed analyses
const completedCount = reduce(
  analyses,
  0,
  (acc, analysis) => acc + (analysis.pending ? 0 : 1)
);

// Step 3: Collect all links from completed analyses
const allLinks = reduce(
  analyses,
  [] as string[],
  (acc, analysis) => {
    if (analysis.pending) return acc;
    return [...acc, ...analysis.result.links];
  }
);

// Step 4: Process novel links (keyed - same URL won't be re-fetched)
const linkedContent = mapByKey(
  allLinks,
  (link) => fetchContent(link)
);
```

### Why This Works

1. **mapByKey provides stable identity** - reordering doesn't cause re-processing
2. **reduce aggregates incrementally** - each completion updates the aggregate
3. **Keys flow through** - same URL = same cached result at every stage

---

## Quick Reference

```typescript
// reduce() - aggregate array into single value
reduce(array, initialValue, (acc, item) => newAcc)
reduce(array, initialValue, (acc, item, index) => newAcc)  // with index

// mapByKey() - map with stable key-based identity
mapByKey(array, callback)                     // item value as key
mapByKey(array, "propertyName", callback)     // property as key
mapByKey(array, ["nested", "prop"], callback) // nested property as key
```

---

## See Also

- [CELLS_AND_REACTIVITY.md](CELLS_AND_REACTIVITY.md) - Core reactivity concepts
- [PATTERNS.md](PATTERNS.md) - Common pattern examples
