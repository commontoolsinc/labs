# computed()

`computed()` derives reactive data — strings, numbers, arrays, objects — from
other reactive values. Anything referenced inside the body is automatically
tracked as a dependency, and the result updates when its inputs change.

```tsx
// Shown inside a pattern body.
// ✅ computed() derives data, outside JSX
const filteredItems = computed(() => {
  const query = searchQuery.get().toLowerCase();
  return items.filter((item) => item.title.toLowerCase().includes(query));
});

// ❌ computed() does NOT gate UI — use plain ternaries in JSX instead
{showForm ? <div>Form content</div> : null}
```

**Rule of thumb:** `computed()` is for deriving data. For conditional
rendering or other simple conditional values in normal pattern code, use plain
ternaries — see [Conditional Rendering](../../patterns/conditional.md).

## Availability Inside a Computation

An explicit computation can inspect unavailable states when it captures the
visible `AsyncResult<T>` request. Keep the usable `resultOf()` alias outside so
the request and result remain one reactive source:

```typescript
// Shown for illustration only.
const repoRequest = fetchJson<Repo>({ url });
const repo = resultOf(repoRequest);

const label = computed(() =>
  isPending(repoRequest)
    ? "Loading…"
    : hasError(repoRequest)
      ? `Error: ${repoRequest.error.message}`
      : repo.name
);
```

The computation runs for the reasons it explicitly guards. Other unavailable
states propagate without invoking its body. This is the normal fetch and
generation pattern: do not wrap `repoRequest` in `observeAvailability()` because
its `AsyncResult<Repo>` type already gives the transformer the union and guards
it needs.

`observeAvailability()` is a narrow compatibility escape hatch, not part of the
normal request/result workflow. Use it only when all of these are true:

- a reactive value is statically plain `T` but may carry an unavailable marker
  propagated by an upstream computation;
- the originating `AsyncResult` is hidden behind a legacy or encapsulated piece
  boundary; and
- that upstream contract cannot yet be changed to expose `AsyncResult<T>` or
  the original request.

```typescript
// Shown for illustration only.
// input.label comes from an older piece which exposes only `string`.
const labelOrError = observeAvailability(input.label, "error");
const displayLabel = computed(() =>
  hasError(labelOrError)
    ? `Unavailable: ${labelOrError.error.message}`
    : labelOrError
);
```

The call must be outside the `computed()` boundary it changes. If the original
request is available, guard that request instead. If you own the upstream
boundary, prefer fixing its type rather than recovering hidden availability
downstream.

## When NOT to Use computed()

**Never inside JSX for interpolation or property access** — reactivity is
automatic there:

```tsx
// Shown for illustration only.
// ❌ Unnecessary
<div>{computed(() => `Hello, ${userName}`)}</div>
<div>{computed(() => user.name)}</div>

// ✅ Just reference directly
<div>Hello, {userName}</div>
<div>{user.name}</div>
```

**Never inside JSX to gate sections.** Inside a `computed()` body, ternaries
and logical operators are **not** transformed — they execute as plain JS where
a `Writable<boolean>` is always truthy. This is the most common source of
"conditional section always renders" bugs:

```tsx
// Shown inside a pattern body.
// ❌ WRONG - the ternary inside the computed body is plain JS;
// `showForm` is a Writable object (always truthy), so the form always renders
{computed(() => {
  if (!adminMode.get()) return null;
  return <>{showForm ? <div>ALWAYS renders!</div> : null}</>;
})}

// ✅ RIGHT - plain ternaries at lowered sites, including nested ones
{adminMode
  ? <>{showForm ? <div>Form content</div> : null}</>
  : null}
```

See [Conditional Rendering](../../patterns/conditional.md) for which sites the
transformer lowers and the eager-branch-evaluation caveat.

**Never nested.** The inner `computed()` returns a cell reference, not a
value, which breaks reactivity:

```typescript
// Shown inside a pattern body.
// ❌ WRONG - never nest computed()
const badValue = computed(() => 123 + computed(() => myCell.get() * 2));

// ✅ CORRECT - declare separately
const doubled = computed(() => myCell.get() * 2);
const goodValue = computed(() => 123 + doubled);
```

## Dynamic `[NAME]`

Input props are reactive and can't be read at init time. Wrap derived names in
`computed()` (static strings don't need it):

```tsx
// Shown for illustration only.
// ❌ Error: reactive reference outside context
[NAME]: `Study: ${deck.name}`,

// ✅ computed() creates a reactive context
[NAME]: computed(() => `Study: ${deck.name}`),
```

## Side Effects in computed()

If your `computed()` has side effects (like setting another cell), they should be idempotent. Non-idempotent side effects cause the scheduler to re-run repeatedly until it hits the 101-iteration limit.

```typescript
// Shown inside a pattern body.
// ❌ Non-idempotent - appends on every run
const badComputed = computed(() => {
  const current = logArray.get();
  logArray.set([...current, { timestamp: safeDateNow() }]); // Grows forever
  return items.length;
});

// ✅ Idempotent - check-before-write with deterministic key
const goodComputed = computed(() => {
  const current = cacheMap.get();
  const key = `items-${items.length}`;
  if (!(key in current)) {
    cacheMap.set({ ...current, [key]: safeDateNow() });
  }
  return items.length;
});
```

The scheduler re-runs computations when their dependencies change. If a computation modifies a cell it depends on, it triggers itself. With idempotent operations, the second run produces no change, so the system settles.

Prefer using handlers for mutations instead of side effects in `computed()`.

## Reusable Computations: lift()

`lift()` defines a reusable reactive computation at module scope. `computed()`
is almost always better — reach for `lift()` only when the same derivation is
used in multiple patterns or called multiple times in one pattern:

```typescript
// Shown for illustration only.
// Module scope - reusable across patterns
const getByDate = lift((args: { grouped: Record<string, Item[]>; date: string }) =>
  args.grouped[args.date]
);

// Inside pattern: bind reactive inputs
const result = getByDate({ grouped, date });

// For one-off use, prefer computed()
const result = computed(() => grouped[date]);
```

Like `handler()`, `lift()` must be defined at module scope, never inside the
pattern body — see [Module Scope Requirement](../handler.md#module-scope-requirement)
for why.

## Escape Hatches

- **`.sample()`** reads a cell **without creating a reactive dependency** —
  the computed won't re-run when that cell changes. Use it for config/initial
  values, breaking intentional reactive loops, or snapshotting. Overuse leads
  to stale data.
  ```typescript
  // Shown inside a pattern body.
  const result = computed(() => {
    const user = userCell.get(); // dependency - re-runs on change
    const initial = configCell.sample(); // NO dependency
    return doSomething(user, initial);
  });
  ```
- **Imperative code** (for-loops, accumulation, `let`) belongs inside
  `computed()` bodies, not at pattern scope. The body is plain JS over
  unwrapped values.

## Direct Property Access on Computed Objects

Properties of object-shaped computeds can be accessed directly, including in
JSX:

```tsx
// Shown for illustration only.
const data = computed(() => ({ users, posts, config }));

<div>{data.users.length} users</div>
<div>Theme: {data.config.theme}</div>
{data.users.map((user) => <div>{user.name}</div>)}
```

## Cookbook

**Group by:**

```tsx
// Shown inside a pattern body.
const groupedItems = computed(() => {
  const groups: Record<string, Item[]> = {};
  for (const item of items) {
    const cat = item.category || "Uncategorized";
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(item);
  }
  return groups;
});
const categories = computed(() => Object.keys(groupedItems).sort());

// In JSX:
{categories.map((cat) => (
  <div>
    <h3>{cat}</h3>
    {(groupedItems[cat] ?? []).map((item) => <div>{item.title}</div>)}
  </div>
))}
```

**Filter / search:**

```tsx
// Shown inside a pattern body.
const searchQuery = new Writable("");
const filteredItems = computed(() =>
  items.filter((item) =>
    item.title.toLowerCase().includes(searchQuery.get().toLowerCase())
  )
);

// <cf-input $value={searchQuery} placeholder="Search..." />
// {filteredItems.map((item) => <div>{item.title}</div>)}
```

**Statistics** (object-shaped computed; format with `.toFixed()` at the use
site):

```tsx
// Shown inside a pattern body.
const stats = computed(() => ({
  total: items.length,
  completed: items.filter((item) => item.done).length,
  completionRate: items.length > 0
    ? (items.filter((item) => item.done).length / items.length) * 100
    : 0,
}));

// <div>Progress: {stats.completionRate.toFixed(1)}%</div>
```

For the hierarchical summary string convention used by container patterns, see
[Summary Convention](../../conventions/summary.md).
