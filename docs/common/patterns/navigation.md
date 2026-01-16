# Navigation to Detail Views

Use `navigateTo()` for drilling into detail views from list patterns.

## List Pattern

```typescript
import { navigateTo, pattern, UI, Writable } from "commontools";
import ItemDetail from "./item-detail.tsx";

interface Item {
  name: string;
  status: string;
}

interface Input {
  items: Writable<Item[]>;
}

export default pattern<Input>(({ items }) => ({
  [UI]: (
    <ct-screen>
      {items.map((item) => (
        <ct-card>
          {item.name}
          <ct-button onClick={() => navigateTo(ItemDetail({ item }))}>
            Edit
          </ct-button>
        </ct-card>
      ))}
    </ct-screen>
  ),
  items,
}));
```

## Detail Pattern with `.key()`

The detail pattern receives a `Writable<Item>` and uses `.key()` to access individual fields for editing:

```typescript
import { pattern, UI, Writable } from "commontools";

interface Item {
  name: string;
  status: string;
}

interface Input {
  item: Writable<Item>;  // Single Writable of the whole object
}

export default pattern<Input>(({ item }) => ({
  [UI]: (
    <ct-screen>
      <ct-input $value={item.key("name")} placeholder="Name" />
      <ct-select
        $value={item.key("status")}
        items={[
          { label: "Active", value: "active" },
          { label: "Done", value: "done" },
        ]}
      />
    </ct-screen>
  ),
  item,
}));
```

**Why `.key()`?** When you need to edit fields of an object passed from a list:
- Use `Writable<Item>` (not separate Writables for each field)
- Use `.key("fieldName")` to get a Writable for that specific field
- The `.key()` result works directly with `$value` bindings
- Changes sync automatically back to the list

## Canonical Example

See `packages/patterns/reading-list/` for a complete implementation:
- `reading-list.tsx` - List with navigation to detail
- `reading-item-detail.tsx` - Detail view using `.key()` for field editing

## See Also

- [Writable Methods](../concepts/types-and-schemas/writable.md) - `.key()` and other methods
- [Two-Way Binding](./two-way-binding.md) - `$value` binding syntax
- [Conditional Rendering](./conditional.md) - Using ifElse for show/hide
