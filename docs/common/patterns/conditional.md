### Conditional Rendering

```typescript
// ❌ Ternary for elements doesn't work
{show ? <div>Content</div> : null}

// ✅ Use ifElse()
{ifElse(show, <div>Content</div>, null)}

// ✅ Ternary IS fine for attributes
<span style={done ? { textDecoration: "line-through" } : {}}>
```
