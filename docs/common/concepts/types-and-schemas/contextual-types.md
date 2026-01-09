# Types and Schemas

## Type Contexts

Four contexts where types appear differently:

```tsx
import { Default, Writable, pattern, UI } from 'commontools';

interface ShoppingItem {
  title: string;
  done: Default<boolean, false>;
}

// Context 1: Schema definition
interface Input {
  items: Default<ShoppingItem[], []>;
}

// Context 2: Pattern parameter (with Writable<> for write access)
interface WritableInput {
  items: Writable<ShoppingItem[]>;
}

export default pattern<WritableInput>(({ items }) => {
  // Context 3: items is Writable<ShoppingItem[]>

  return {
    [UI]: (
      <div>
        {items.map((item) => (
          <ct-checkbox $checked={item.done}>{item.title}</ct-checkbox>
        ))}
      </div>
    ),
  };
});
```
