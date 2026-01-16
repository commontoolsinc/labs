## Ternaries in JSX

Use regular ternary operators in JSX - the transformer automatically converts them to `ifElse()`:

```tsx
// ✅ Just use ternaries - they're transformed automatically
{show ? <div>Content</div> : null}
{user.isActive ? "Active" : "Inactive"}
{count > 10 ? "High" : "Low"}

// ✅ Nested ternaries work too
{score >= 90 ? "A" : score >= 80 ? "B" : "C"}
```

You don't need to use `ifElse()` explicitly in JSX.

## Using ifElse() Directly

You can use `ifElse()` explicitly outside JSX when needed:

```typescript
const message = ifElse(
  user.isLoggedIn,
  str`Welcome back, ${user.name}!`,
  "Please log in"
);

const processedItems = items.map(item =>
  ifElse(
    item.isValid,
    () => processItem(item),
    () => ({ ...item, error: "Invalid" })
  )
);
```
