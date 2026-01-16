# Conditional Rendering with Ternaries

```typescript
// WRONG - Ternaries don't work for elements
{show ? <div>Content</div> : null}

// CORRECT - Use ifElse()
{ifElse(show, <div>Content</div>, null)}

// Ternaries ARE fine for attributes
<span style={done ? { textDecoration: "line-through" } : {}}>{title}</span>
```

**Why:** In the reactive JSX system, ternary operators cannot properly track reactive dependencies for conditional element rendering. The `ifElse()` function is designed to handle this case correctly. However, ternaries work fine for simple attribute values where no element creation is involved.

## See Also

- @common/concepts/reactivity.md - Reactivity system
- @common/components/COMPONENTS.md - UI components
