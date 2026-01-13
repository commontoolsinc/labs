# .get() is Not a Function

**Error:** `X.get is not a function`

**Cause:** Calling `.get()` on a `computed()` or `lift()` result. Only `Writable<>` types have `.get()`.

```typescript
// Given:
const filteredItems = computed(() => items.filter(item => !item.done));

// CORRECT - Access computed results directly
const count = filteredItems.length;
const paulinaItems = filteredItems.filter(item => item.owner === "paulina");

// Also correct for lift() results
const formattedValue = getFormattedDate(date);  // Access directly
```

**Access pattern summary:**
| Type | Has `.get()`? |
|------|---------------|
| `Writable<>` (pattern inputs with write access) | Yes |
| `computed()` results | No - access directly |
| `lift()` results | No - access directly |

## See Also

- @common/concepts/types-and-schemas.md - Type system and `Writable<>` explained
- @common/concepts/reactivity.md - Reactivity system
