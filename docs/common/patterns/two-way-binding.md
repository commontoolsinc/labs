Simple patterns appear very similar to most popular UI frameworks.

Two-way bindings can be declared (for compatible components) with a `$` prefix on their properties. Here is a list with bidirectional binding and inline handlers:

```tsx
import { Default, NAME, pattern, UI, Writable, equals } from "commontools";

interface Item {
  title: string;
  done: Default<boolean, false>;
}

interface Input {
  items: Writable<Item[]>;
}

export default pattern<Input, Input>(({ items }) => ({
  [NAME]: "Shopping List",
  [UI]: (
    <div>
      {items.map((item) => (
        <div>
          <ct-checkbox $checked={item.done}>
            <span style={item.done ? { textDecoration: "line-through" } : {}}>
              {item.title}
            </span>
          </ct-checkbox>
          <ct-button onClick={() => {
            const current = items.get();
            const index = current.findIndex((el) => equals(item, el));
            if (index >= 0) items.set(current.toSpliced(index, 1));
          }}>×</ct-button>
        </div>
      ))}
      <ct-message-input
        placeholder="Add item..."
        onct-send={(e: { detail: { message: string } }) => {
          const text = e.detail.message?.trim();
          if (text) items.push({ title: text, done: false });
        }}
      />
    </div>
  ),
  items,
}));
```

**Key points:**
- `$checked` automatically syncs - no handler needed
- Inline handlers for add/remove operations
- **Uses `equals()` for item identity**
- Ternary in `style` attribute works fine
- Type inference works in `.map()` - no annotations needed
