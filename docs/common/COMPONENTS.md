# ct-button

A styled button component matching the regular `button` API. Pass a handler to the `onClick` prop to bind it.

```tsx
type InputSchema = { count: Cell<number> };
type OutputSchema = { count: Cell<number> };

const MyRecipe = recipe<InputSchema, OutputSchema>("MyRecipe", ({ count }) => {
  const handleClick = handler<unknown, { count: Cell<number> }>((_event, { count }) => {
    count.set(count.get() + 1);
  });

  return {
    [UI]: <ct-button onClick={handleClick({ count })} />,
    count,
  };
});
```

Notice how handlers are bound to the cell from the input schema _in_ the VDOM declaration? That's partial application of the state, the rest of the state (the actual event) comes through as the (unused) `_event` in the handler. This way you can merge the discrete updates from events with the reactive cells that are always changing values.

(For even more detail, see `HANDLERS.md`)

# Bidirectional Binding with $ Prefix

Many CommonTools components support **bidirectional binding** through the `$` prefix. This powerful feature automatically updates cells when users interact with components, eliminating the need for explicit onChange handlers in most cases.

## How Bidirectional Binding Works

When you use `$checked={}`, `$value={}`, or other `$prop` bindings, the component automatically updates the cell when the user interacts with it. **No onChange handler is needed.**

```tsx
// ✅ SIMPLE CASE - Bidirectional binding (preferred)
<ct-checkbox $checked={item.checked} />
<ct-input $value={title} />
<ct-select $value={category} items={[...]} />

// The cell is automatically updated when:
// - User checks/unchecks the checkbox
// - User types in the input
// - User selects from the dropdown
```

## When to Use Handlers vs Bidirectional Binding

### Simple Case: Use Bidirectional Binding

```tsx
// Just sync the UI with the cell - no additional logic needed
<ct-checkbox $checked={item.checked} />
```

### Complex Case: Use Handler for Additional Logic

```tsx
// When you need to run additional code on changes
const toggle = handler(
  (_event, { item }: { item: Cell<Item> }) => {
    item.checked.set(!item.checked.get());
    // Additional side effects here
    console.log("Item toggled:", item);
    saveToBackend(item);
  }
);

<ct-checkbox $checked={item.checked} onChange={toggle({ item })} />
```

**Note:** Even when using a handler, you can still use `$checked` for the binding. The `$` binding handles reading and writing the value, while `onChange` lets you add extra logic.

# ct-input

The `ct-input` component demonstrates bidirectional binding perfectly:

```tsx
type InputSchema = { value: Cell<string> };
type OutputSchema = { value: Cell<string> };

const MyRecipe = recipe<InputSchema, OutputSchema>("MyRecipe", ({ value }) => {
  // Option 1: Bidirectional binding (simplest)
  const simpleInput = <ct-input $value={value} />;

  // Option 2: With handler for additional logic
  const handleChange = handler<
    { detail: { value: string } },
    { value: Cell<string> }
  >((event, { value }) => {
    value.set(event.detail.value);
    console.log("Value changed:", event.detail.value);
  });
  const inputWithHandler = <ct-input value={value} onct-input={handleChange({ value })} />;

  return {
    [UI]: <div>
      {simpleInput}
      {inputWithHandler}
    </div>,
  };
});
```

Both inputs update the cell, but the second one logs changes. Use the simple bidirectional binding unless you need the extra logic.

### Validation

One reason to prefer a handler is validation of the value. This is a good idea, but you can _also_ consider using two cells. A raw input cell and a validated cell derived from the former, e.g.

```tsx
type InputSchema = { rawValue: Cell<string> };
type OutputSchema = { validatedValue: string | null };

const MyRecipe = recipe<InputSchema, OutputSchema>("MyRecipe", ({ rawValue }) => {
  // Example 1: Using full event object
  // Here we destructure the event for convenience/brevity
  const handleChange = handler<{ detail: { value: string } }, { rawValue: Cell<string> }>(({ detail: { value } }, { rawValue }) => {
    rawValue.set(value);
  });

  // Example 2: Destructuring specific event properties (often cleaner)
  const handleChangeDestructured = handler<{ detail: { value: string } }, { rawValue: Cell<string> }>(({ detail: { value } }, { rawValue }) => {
    rawValue.set(value);
  });

  // Example 3: When event data isn't needed
  const handleReset = handler<never, { rawValue: Cell<string> }>((_ , { rawValue }) => {
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

# ct-select

The `ct-select` component creates a dropdown selector. **Important:** It uses an `items` attribute with an array of `{ label, value }` objects, **not** HTML `<option>` elements.

```tsx
type CategoryInput = {
  category: Default<string, "Other">;
};

const MyRecipe = recipe<CategoryInput, CategoryInput>("MyRecipe", ({ category }) => {
  return {
    [UI]: (
      <ct-select
        $value={category}
        items={[
          { label: "Produce", value: "Produce" },
          { label: "Dairy", value: "Dairy" },
          { label: "Meat", value: "Meat" },
          { label: "Other", value: "Other" },
        ]}
      />
    ),
    category,
  };
});
```

## ct-select API Details

### items attribute

The `items` attribute takes an array of objects with `label` and `value` properties:

```tsx
// ✅ CORRECT - Use items attribute
<ct-select
  $value={selectedValue}
  items={[
    { label: "Display Text 1", value: "actual_value_1" },
    { label: "Display Text 2", value: "actual_value_2" },
  ]}
/>

// ❌ INCORRECT - Don't use <option> elements
<ct-select $value={selectedValue}>
  <option value="actual_value_1">Display Text 1</option>
  <option value="actual_value_2">Display Text 2</option>
</ct-select>
```

### Values can be any type

The `value` property doesn't have to be a string - it can be any type:

```tsx
// Numeric values
<ct-select
  $value={selectedId}
  items={[
    { label: "First Item", value: 1 },
    { label: "Second Item", value: 2 },
    { label: "Third Item", value: 3 },
  ]}
/>

// Boolean values
<ct-select
  $value={isEnabled}
  items={[
    { label: "Enabled", value: true },
    { label: "Disabled", value: false },
  ]}
/>

// Object values
<ct-select
  $value={selectedUser}
  items={users.map(user => ({
    label: user.name,
    value: user,
  }))}
/>
```

### Bidirectional binding

Like other components, `ct-select` supports bidirectional binding with the `$value` prefix, automatically updating the cell when the user selects an option.

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
>(({ detail: { message } }, { list }) => {
  const item = message?.trim();
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
import {
  h,
  derive,
  handler,
  ifElse,
  NAME,
  recipe,
  str,
  UI,
  OpaqueRef,
  Cell,
  Default,
  Opaque,
} from "commontools";

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
