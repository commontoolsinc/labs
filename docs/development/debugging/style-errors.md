# Style Errors

## String Style on HTML Elements

**Error:** "Type 'string' is not assignable to type 'CSSProperties'"

**Problem:** Using CSS string syntax on HTML elements

```typescript
<div style="flex: 1; padding: 1rem;">  {/* Error! */}
  Content
</div>
```

**Solution:** Use object syntax for HTML elements

```typescript
<div style={{ flex: 1, padding: "1rem" }}>  {/* Correct! */}
  Content
</div>
```

## Object Style on Custom Elements

**Error:** Styles not applying to custom elements

**Problem:** Using object syntax on custom elements

```typescript
<common-hstack style={{ padding: "1rem" }}>  {/* Won't work */}
  Content
</common-hstack>
```

**Solution:** Use string syntax for custom elements

```typescript
<common-hstack style="padding: 1rem;">  {/* Correct! */}
  Content
</common-hstack>
```

## Style Syntax Quick Reference

| Element Type | Style Syntax | Property Format | Example |
|--------------|--------------|-----------------|---------|
| HTML (`div`, `span`, `button`) | Object | camelCase | `style={{ flex: 1, backgroundColor: "#fff" }}` |
| Custom (`common-*`, `ct-*`) | String | kebab-case | `style="flex: 1; background-color: #fff;"` |

## See Also

- [@COMPONENTS](../../common/components/COMPONENTS.md) - Component reference and styling
