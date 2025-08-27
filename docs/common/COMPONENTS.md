# ct-button

A styled button component matching the regular `button` API. Pass a handler to the `onClick` prop to bind it.

```tsx
type InputSchema = { count: Cell<number> };
type OutputSchema = { count: Cell<number> };

const MyRecipe = recipe<InputSchema, OutputSchema>("MyRecipe", ({ count }) => {
  const handleClick = handler<Record<string, never>, { count: Cell<number> }>((e, { count }) => {
    count.set(count.get() + 1);
  });

  return {
    [UI]: <ct-button onClick={handleClick({ count })} />,
    count,
  };
});
```

Notice how handlers are bound to the cell from the input schema _in_ the VDOM declaration? That's partial application of the state, the rest of the state (the actual event) comes through as `e` in the handler. This way you can merge the discrete updates from events with the reactive cells that are always changing values.

(For even more detail, see `HANDLERS.md`)

# ct-input

Some components can work with a cell directly, as well as using handlers.

```tsx
type InputSchema = { value: Cell<string> };
type OutputSchema = { value: Cell<string> };

const MyRecipe = recipe<InputSchema, OutputSchema>("MyRecipe", ({ value }) => {
  const handleChange = handler<{ detail: { value: string } }, { value: Cell<string> }>((e, { value }) => {
    value.set(e.detail.value);
  });

  return {
    [UI]: <div>
      <ct-input value={value} onct-input={handleChange({ value })} />
      <ct-input $value={value} />
    </div>,
  };
});
```

These two inputs are functionally equivalent. They both update the cell with the value from the input event, providing a cell via the `$` prefix allows the component to call `.set()` on the cell internally - reducing boilerplate.

### Validation

One reason to prefer a handler is validation of the value. This is a good idea, but you can _also_ consider using two cells. A raw input cell and a validated cell derived from the former, e.g.

```tsx
type InputSchema = { rawValue: Cell<string> };
type OutputSchema = { validatedValue: string | null };

const MyRecipe = recipe<InputSchema, OutputSchema>("MyRecipe", ({ rawValue }) => {
  // Example 1: Using full event object 
  const handleChange = handler<{ detail: { value: string } }, { rawValue: Cell<string> }>((e, { rawValue }) => {
    rawValue.set(e.detail.value);
  });

  // Example 2: Destructuring specific event properties (often cleaner)
  const handleChangeDestructured = handler<{ detail: { value: string } }, { rawValue: Cell<string> }>(({ detail }, { rawValue }) => {
    rawValue.set(detail.value);
  });

  // Example 3: When event data isn't needed
  const handleReset = handler<Record<string, never>, { rawValue: Cell<string> }>((_ , { rawValue }) => {
    rawValue.set("");
  });

  const validatedValue = derive(rawValue, v => v.length > 0 ? v : null);

  return {
    [UI]: <div>
      <ct-input $value={rawValue} onChange={handleChange({ rawValue })} />
      <ct-button onClick={handleReset({ rawValue })}>Reset</ct-button>
    </div>,
    validatedValue
  };
});
```

# ct-list

When working with a list of objects, of any kind, if they have `title` properties you can display and manage them via a `ct-list` component.

```tsx
type Item = { title: string };
type ListSchema = { items: Cell<Item[]> };

const MyRecipe = recipe<ListSchema, ListSchema>("MyRecipe", ({ items }) => {
  return {
    [UI]: <div>
      <ct-list $items={items} editable={false} />
    </div>,
    items,
  };
});
```

# ct-message-input

This component bundles an input and a button to 'send a message' or 'add an item to a list' which is a common pattern. You don't need to worry about the value until submission time.

```tsx
const addItem = handler<
  { detail: { message: string } },
  { list: { title: string; items: Cell<any[]> } }
>((event, { list }) => {
  const item = event.detail?.message?.trim();
  if (item) list.items.push({ title: item });
});

// ...

<ct-message-input
  buttonText="Add item"
  placeholder="New item"
  onct-send={addItem({ list })}
/>
````

# ct-outliner

`ct-outliner` is conceptually similar to `ct-list` except it works on a tree data structure. Below is a demonstration of the minimal use, see `page.tsx` for a more complete example.

This example also demonstrates verbose specification of more complex types.

```tsx
import { Default, OpaqueRef } from "commontools";

type Charm = any;

type OutlinerNode = {
  body: Default<string, "">;
  children: Default<any[], []>;
  attachments: Default<OpaqueRef<any>[], []>;
};

type Outliner = {
  root: OutlinerNode;
};

type PageResult = {
  outline: Cell<
    Default<Outliner, { root: { body: ""; children: []; attachments: [] } }>
  >;
};

export type PageInput = {
  outline: Cell<Outliner>;
};

export default recipe<PageInput, PageResult>(
  "Outliner Page",
  ({ outline }) => {
    return {
      [NAME]: "Outliner",
      [UI]: (
        <div>
          <label>Content</label>
          <ct-outliner $value={outline} />
        </div>
      ),
      outline,
    };
  },
);
```
