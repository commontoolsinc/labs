# ct-button

A styled button component matching the regular `button` API. Pass a handler to the `onClick` prop to bind it.

```tsx
type InputSchema = { count: Cell<number> };
type OutputSchema = { count: Cell<number> };

const MyRecipe = recipe<InputSchema, OutputSchema>(({ count }) => {
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

## Bidirectional Binding with $ Prefix

Many CommonTools components support **bidirectional binding** through the `$` prefix. This powerful feature automatically updates cells when users interact with components, eliminating the need for explicit onChange handlers in most cases.

**This is one of the most important patterns to understand when building recipes.** Most UI updates can be handled with bidirectional binding alone, making your code simpler and easier to maintain.

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

## Bidirectional Binding with Array Items

When working with arrays, bidirectional binding works seamlessly with mapped items:

```tsx
interface ShoppingItem {
  title: string;
  done: Default<boolean, false>;
  category: Default<string, "Other">;
}

// In your recipe
{items.map((item) => (
  <div>
    <ct-checkbox $checked={item.done}>
      <span>{item.title}</span>
    </ct-checkbox>
    <ct-input $value={item.category} />
  </div>
))}
```

## When to Use Handlers vs Bidirectional Binding

### Decision Matrix

| Scenario | Use Bidirectional Binding | Use Handler |
|----------|--------------------------|-------------|
| Simple value updates | ✅ Yes | ❌ No |
| Checkbox toggle | ✅ Yes | ❌ No |
| Text input | ✅ Yes | ❌ No |
| Dropdown selection | ✅ Yes | ❌ No |
| Need validation | ❌ No | ✅ Yes |
| Need side effects (logging, API calls) | ❌ No | ✅ Yes |
| Complex state transformations | ❌ No | ✅ Yes |

### Simple Case: Use Bidirectional Binding

```tsx
// ❌ AVOID - Unnecessary handler for simple value update
const toggle = handler<{detail: {checked: boolean}}, {item: Cell<Item>}>(
  ({detail}, {item}) => {
    item.set({...item.get(), done: detail.checked});
  }
);
<ct-checkbox checked={item.done} onct-change={toggle({item})} />

// ✅ PREFERRED - Bidirectional binding handles it
<ct-checkbox $checked={item.done} />
```

The bidirectional binding version is:

- **Simpler**: No handler definition needed
- **Less code**: One line instead of five
- **More maintainable**: Less surface area for bugs
- **Just as powerful**: The update happens automatically

### Complex Case: Use Handler for Additional Logic

```tsx
// ✅ CORRECT - Handler needed for side effects
const toggle = handler(
  (_event, { item }: { item: Cell<Item>, items: Item[], max: number }) => {
    const currentValue = item.done.get();
    const doneCount = items.filter(item => item.done).length;

    if (currentValue || max === undefined || doneCount < max) {
      item.done.set(!currentValue);
    } else {
  }
);

<ct-checkbox $checked={item.done} onct-change={toggle({ items, item, max = 3 })} />
```

**Note:** When using a handler, use `checked` for the binding, without the $, as
one-directional binding.

Note that the actual name for the `onChange` handler may be different depending
on the component being used. For example, `<ct-checkbox>` uses `onct-change`.
Consult the component for details.

### Validation Example

For validation, consider using two cells: a raw input cell and a validated derived cell:

```tsx
// Raw input with bidirectional binding
const rawInput = cell("");

<ct-input $value={rawInput} />

// Validated output using derive
const validatedValue = derive(rawInput, (value) => {
  if (value.length < 3) return null;
  if (!value.match(/^[a-z]+$/i)) return null;
  return value;
});

// Show validation status
{v !== null ?
  <span style={{ color: "green" }}>✓ Valid</span> :
  <span style={{ color: "red" }}>✗ Must be 3+ letters</span>
}
```

This approach separates concerns: bidirectional binding handles the UI sync, while derive handles validation logic.

## Styling: String vs Object Syntax

Different element types accept different style syntax in CommonTools JSX. This is a common source of TypeScript errors.

## HTML Elements: Object Syntax

HTML elements (`div`, `span`, `button`, etc.) use JavaScript object syntax for styles:

```tsx
// ✅ CORRECT - Object syntax for HTML elements
<div style={{ flex: 1, padding: "1rem", marginBottom: "0.5rem" }}>
  <span style={{ color: "red", fontWeight: "bold" }}>Error</span>
  <button style={{ backgroundColor: "#007bff", color: "white" }}>
    Submit
  </button>
</div>

// ❌ WRONG - String syntax doesn't work on HTML elements
<div style="flex: 1; padding: 1rem;">
  {/* TypeScript error: Type 'string' is not assignable to type 'CSSProperties' */}
</div>
```

**Properties use camelCase**: `backgroundColor`, `fontSize`, `marginBottom`

## Custom Elements: String Syntax

CommonTools custom elements (`common-hstack`, `common-vstack`, `ct-card`, etc.) use CSS string syntax:

```tsx
// ✅ CORRECT - String syntax for custom elements
<common-hstack gap="sm" style="align-items: center; padding: 1rem;">
  <common-vstack gap="md" style="flex: 1; max-width: 600px;">
    <ct-card style="border: 1px solid #ccc; padding: 0.5rem;">
      Content here
    </ct-card>
  </common-vstack>
</common-hstack>

// ❌ WRONG - Object syntax causes errors on custom elements
<common-hstack style={{ alignItems: "center" }}>
  {/* Error: Custom elements expect string styles */}
</common-hstack>
```

**Properties use kebab-case**: `background-color`, `font-size`, `margin-bottom`

## Quick Reference Table

| Element Type | Style Syntax | Property Format | Example |
|--------------|--------------|-----------------|---------|
| HTML (`div`, `span`, `button`) | Object | camelCase | `style={{ flex: 1, backgroundColor: "#fff" }}` |
| Custom (`common-*`, `ct-*`) | String | kebab-case | `style="flex: 1; background-color: #fff;"` |

## Mixed Usage Example

```tsx
// You'll often mix both types in one recipe
<div style={{ display: "flex", gap: "1rem" }}>
  <common-vstack gap="md" style="flex: 1; padding: 1rem;">
    <span style={{ color: "#333", fontSize: "14px" }}>
      Label Text
    </span>
    <ct-button>Click Me</ct-button>
  </common-vstack>
</div>
```

## Common Errors and Solutions

**Error**: `Type 'string' is not assignable to type 'CSSProperties'`

```tsx
// ❌ Problem: Using string on HTML element
<div style="display: flex;">

// ✅ Solution: Use object syntax
<div style={{ display: "flex" }}>
```

**Error**: Styles not applying to custom elements

```tsx
// ❌ Problem: Using object on custom element
<common-hstack style={{ padding: "1rem" }}>

// ✅ Solution: Use string syntax
<common-hstack style="padding: 1rem;">
```

## ct-input

The `ct-input` component demonstrates bidirectional binding perfectly:

```tsx
type InputSchema = { value: Cell<string> };
type OutputSchema = { value: Cell<string> };

const MyRecipe = recipe(({ value }: InputSchema) => {
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

## ct-select

The `ct-select` component creates a dropdown selector. **Important:** It uses an `items` attribute with an array of `{ label, value }` objects, **not** HTML `<option>` elements.

```tsx
type CategoryInput = {
  category: Default<string, "Other">;
};

const MyRecipe = recipe(({ category }: CategoryInput) => {
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

## ct-list

The `ct-list` component provides a convenient way to display and manage lists, but it has **specific schema requirements**.

## Schema Requirements

`ct-list` requires items to have a `title` property and optionally a `done` property:

```tsx
// ✅ CORRECT - Items match ct-list schema
interface CtListItem {
  title: string;      // Required
  done?: boolean;     // Optional
}

type ListSchema = { items: Cell<CtListItem[]> };

const MyRecipe = recipe(({ items }: ListSchema) => {
  return {
    [UI]: <div>
      <ct-list $items={items} editable={false} />
    </div>,
    items,
  };
});
```

## When NOT to Use ct-list

If your data has custom fields beyond `title` and `done`, you **cannot** use `ct-list`. You must render manually:

```tsx
// ❌ CANNOT use ct-list - has custom fields
interface ShoppingItem {
  title: string;
  done: boolean;
  category: string;  // ← Custom field
  quantity: number;  // ← Custom field
}

// ✅ CORRECT - Manual rendering for custom fields
{items.map((item) => (
  <div>
    <ct-checkbox $checked={item.done}>
      {item.title}
    </ct-checkbox>
    <ct-input $value={item.category} placeholder="Category" />
    <ct-input $value={item.quantity} type="number" placeholder="Qty" />
  </div>
))}
```

## Trade-offs

**Use ct-list when:**

- Your items only need `title` and optionally `done`
- You want a quick, pre-styled list component
- You don't need custom rendering

**Use manual rendering when:**

- You have custom fields
- You need custom styling or layout
- You need fine-grained control over interactions

## ct-message-input

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

## ct-outliner

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

## ct-render

The `ct-render` component displays pattern instances within another pattern. Use this for **pattern composition** - combining multiple patterns together in a single recipe.

## Basic Usage

```tsx
import { recipe, UI, NAME } from "commontools";
import MyPattern from "./my-pattern.tsx";

export default recipe("Composed Pattern", ({ items }) => {
  // Create pattern instance
  const patternInstance = MyPattern({ items });

  return {
    [NAME]: "Composed Pattern",
    [UI]: (
      <div>
        {/* Render the pattern */}
        <ct-render $cell={patternInstance} />
      </div>
    ),
  };
});
```

## Critical: Use $cell not charm

This is the most common mistake when using ct-render:

```tsx
// ❌ WRONG - Using charm attribute doesn't work
<ct-render charm={patternInstance} />

// ❌ WRONG - Using pattern attribute doesn't work
<ct-render pattern={patternInstance} />

// ✅ CORRECT - Use $cell for bidirectional binding
<ct-render $cell={patternInstance} />
```

**Why `$cell`?** The `$cell` attribute enables bidirectional binding with the pattern instance. When the pattern's internal state changes, the parent pattern automatically sees those changes through the shared cell reference.

## Multiple Patterns Sharing Data

A common use case is displaying the same data in different ways:

```tsx
import { recipe, UI, NAME, Default } from "commontools";
import ListView from "./list-view.tsx";
import GridView from "./grid-view.tsx";

interface Item {
  title: string;
  done: Default<boolean, false>;
}

interface Input {
  items: Default<Item[], []>;
}

export default recipe(({ items }: Input) => {
  // Both patterns receive the same items cell
  const listView = ListView({ items });
  const gridView = GridView({ items });

  return {
    [NAME]: "Multi-View",
    [UI]: (
      <div style={{ display: "flex", gap: "1rem" }}>
        <div style={{ flex: 1 }}>
          <h3>List View</h3>
          <ct-render $cell={listView} />
        </div>
        <div style={{ flex: 1 }}>
          <h3>Grid View</h3>
          <ct-render $cell={gridView} />
        </div>
      </div>
    ),
    items,
  };
});
```

**What happens:**

- Both patterns receive the same `items` cell reference
- Changes in ListView automatically appear in GridView
- Changes in GridView automatically appear in ListView
- The parent pattern's `items` also stays in sync

## Alternative Rendering Methods

There are three equivalent ways to render a pattern instance:

```tsx
const counter = Counter({ value: state.value });

// Method 1: Direct interpolation (simplest)
<div>{counter}</div>

// Method 2: JSX component syntax
<Counter value={state.value} />

// Method 3: Explicit ct-render (most explicit)
<ct-render $cell={counter} />
```

**When to use each:**

- **Direct interpolation** (`{counter}`): Simple cases, most concise
- **JSX component syntax** (`<Counter />`): When you want it to look like a component
- **ct-render** (`<ct-render $cell={counter} />`): When the pattern wasn't instantiated from within this pattern but was passed in or was stored in a list.

## Pattern Composition vs Linked Charms

Understanding when to use ct-render vs charm linking:

| Scenario | Use |
|----------|-----|
| Multiple views of same data in one recipe | ct-render (Pattern Composition) |
| Components reused within a recipe | ct-render (Pattern Composition) |
| Independent charms that communicate | Linked Charms (separate deployments) |
| Separate deployments with data flow | Linked Charms |

## Complete Example

See `packages/patterns/composed-simple.tsx` for a minimal, complete example of pattern composition with ct-render.

```tsx
/// <cts-enable />
import { Default, NAME, recipe, UI } from "commontools";
import ShoppingListBasic from "./shopping-list-basic.tsx";
import ShoppingListCategorized from "./shopping-list-categorized.tsx";

interface ShoppingItem {
  title: string;
  done: Default<boolean, false>;
  category: Default<string, "Uncategorized">;
}

interface ComposedInput {
  items: Default<ShoppingItem[], []>;
}

export default recipe<ComposedInput, ComposedInput>(
  "Shopping List - Both Views",
  ({ items }) => {
    // Create pattern instances that share the same items cell
    const basicView = ShoppingListBasic({ items });
    const categoryView = ShoppingListCategorized({ items });

    return {
      [NAME]: "Shopping List - Both Views",
      [UI]: (
        <div style={{ display: "flex", gap: "2rem" }}>
          <div style={{ flex: 1 }}>
            <ct-render $cell={basicView} />
          </div>
          <div style={{ flex: 1 }}>
            <ct-render $cell={categoryView} />
          </div>
        </div>
      ),
      items,
    };
  },
);
```

For more details on pattern composition, see the "Level 4: Pattern Composition" section in `PATTERNS.md`.
