# Navigation to Detail Views

Use `navigateTo()` for drilling into detail views from list patterns.

## Pattern

```typescript
import { navigateTo, pattern, UI } from "commontools";
import ItemDetail from "./item-detail.tsx";

export default pattern<Input, Output>(({ items }) => ({
  [UI]: (
    <ct-screen>
      {items.map((item) => (
        <ct-card onClick={() => navigateTo(ItemDetail({ item }))}>
          {item.name}
        </ct-card>
      ))}
    </ct-screen>
  ),
  items,
}));
```

## Canonical Example

See `reading-list.tsx` for a complete list-to-detail implementation:
- List view uses `navigateTo(ReadingItemDetail({ item }))` on card click
- Detail view receives `item` with editable fields
- Changes sync automatically between views

## See Also

- [Conditional Rendering](./conditional.md) - Using ifElse for show/hide
- `packages/patterns/reading-list.tsx` - List pattern
- `packages/patterns/reading-item-detail.tsx` - Detail pattern
