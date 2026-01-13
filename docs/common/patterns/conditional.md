Use `ifElse()` for conditional logic in reactive contexts:

```typescript
// ✅ Use ifElse for conditional rendering
const message = ifElse(
  user.isLoggedIn,
  str`Welcome back, ${user.name}!`,
  "Please log in"
);

<div>{message}</div>

// ✅ Use ifElse in data transformations
const processedItems = items.map(item =>
  ifElse(
    item.isValid,
    () => processItem(item),
    () => ({ ...item, error: "Invalid" })
  )
);
```

### Conditional Rendering

```typescript
// ❌ Ternary for elements doesn't work
{show ? <div>Content</div> : null}

// ✅ Use ifElse()
{ifElse(show, <div>Content</div>, null)}

// ✅ Ternary IS fine for attributes
<span style={done ? { textDecoration: "line-through" } : {}}>
```
