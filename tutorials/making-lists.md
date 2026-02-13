---
title: Making Lists
short_title: Making Lists
description: Creating and working with lists in Common Tools
subject: Tutorial
authors:
  - name: Ellyse Cedeno
    email: ellyse@common.tools
keywords: commontools, lists, arrays, state
abstract: |
  In this section, we learn how to create and work with lists in the Common
  Tools runtime. We'll especially focus on displaying lists and manipulating them.
---

# Making Lists

## Introduction

Whatever it is you are building, you'll very likely need to display a list at
some point. We'll go over how to do that within patterns.

Lists are essential for displaying collections of data—whether it's a todo list,
a contact list, or a feed of messages.

**Important Concept: Bidirectional Binding**

Before we dive in, know that CommonTools components support **bidirectional binding** with the `$` prefix (`$value`, `$checked`, etc.). This automatically updates cells when users interact with components, often eliminating the need for handlers! We'll introduce this concept as we go, but keep in mind: if you're just syncing UI ↔ data with no additional logic, bidirectional binding is usually simpler than using handlers.

## Our First List

Let's start simple: we'll create a list of our friends. We'll make an array of 5
names using `Default<>` (from the previous chapter).

We'll need the following imports for this pattern:

```{code-block} typescript
:label: making_lists_imports
:linenos: false
:emphasize-lines:
/// <cts-enable />
import {
  Default,
  h,
  pattern,
  UI,
} from "commontools";
```

Now we define our state interface with `Default<>` to hold our list of friends:

```{code-block} typescript
:label: making_lists_interface
:linenos: true
:emphasize-lines: 1-11
interface FriendListState {
  names: Default<
    { name: string }[],
    [
      { name: "Alice" },
      { name: "Bob" },
      { name: "Charlie" },
      { name: "Diana" },
      { name: "Evan" },
    ]
  >;
}
```

Lines 1-11 define our state interface. The `Default<>` type tells the runtime to
create a Cell that holds an array of objects (each with a `name` property) and
initialize it with our five friend names.

With our state defined, we can now display the names in the pattern's [UI]. We'll use
the `.map()` function to iterate over each name and render it as a list item:

```{code-block} typescript
:label: making_lists_map
:linenos: true
:emphasize-lines: 3-5
<ul>
  {state.names.map((friend) => (
    <li>{friend.name}</li>
  ))}
</ul>
```

The `.map()` function (line 2) iterates over each friend object in our array.
For each friend, we create an `<li>` element (line 3) that displays the friend's
name property.

:::{dropdown} View complete code
:animate: fade-in

```{literalinclude} ./code/making_lists_simple.tsx
:language: typescript
```

:::

We've demonstrated the following concepts:

- How to define a state interface with `Default<>` for an array of objects
- Use `.map()` to iterate over the array and render list items
- Access object properties in JSX templates
- Create a simple unordered list in the `[UI]`
- Export Cells in the return statement

:::{admonition} Why use Default<>?
Even though we initialize the array with static values, using `Default<>` creates
a reactive Cell. This means when we later add functionality to modify the list
(like adding or removing names), the UI will automatically update. If we used a
plain array instead, changes wouldn't trigger UI updates.
:::

## Removing Items

In this section we'll build a feature to remove friends from our list. We'll add
an onclick listener to the list item and our handler will delete the item from
the list.

:::{admonition} Using reference to array element
Instead of passing an index of the element in the array that we want to remove,
we'll pass a reference to the actual friend object. This lets us use
Cell equality checking (`.key(i).equals(friend)`) to find and remove the right
item. We often pass references to share information from one cell to another or
even one pattern to another as we'll see later.
:::

First, we need to import the `handler` function and `Cell` type:

```{code-block} typescript
:label: making_lists_imports_handler
:linenos: false
:emphasize-lines: 2,4
import {
  type Cell,
  Default,
  h,
  handler,
  pattern,
  UI,
} from "commontools";
```

Next, we'll create a handler that removes an item from the array. Note we currently have a bug in the runtime and therefore we reconstruct the array.

```{code-block} typescript
:label: making_lists_remove_handler
:linenos: true
:emphasize-lines: 1-4,14-20
const removeItem = handler<
  unknown,
  { names: Cell<{ name: string }[]>; friend: { name: string } }
>(
  (_, { names, friend }) => {
    const currentNames = names.get();
    // Ideal code (once bug is fixed):
    // const filtered = currentNames.filter((f, i) =>
    //   !names.key(i).equals(friend as any)
    // );
    // names.set(filtered);

    // Current workaround using reduce with object reconstruction:
    const filtered = currentNames.reduce((acc, _, i) => {
      if (!names.key(i).equals(friend as any)) {
        acc.push({ name: currentNames[i].name });
      }
      return acc;
    }, [] as { name: string }[]);
    names.set(filtered);
  },
);
```

Lines 1-4 define the handler signature. The second type parameter specifies that
we need the `names` Cell and the actual `friend` object to remove (not an
index).

Line 6 gets the current array from the cell.

Lines 7-11 show the ideal code that would work once the runtime bug is fixed—a
simple `.filter()` with `.key(i).equals()` comparison.

Lines 14-19 contain the current workaround using `.reduce()` to build a new
array that excludes the friend we want to remove.

Line 15 uses `.key(i).equals(friend)` to check if the Cell reference at index
`i` matches the friend object we want to remove.

Line 16 explicitly reconstructs each object as `{ name: currentNames[i].name }`
to strip any internal proxy symbols.

Line 20 sets the Cell with the filtered array.

:::{dropdown} Detailed explanation - Why reconstruct the array?
:animate: fade-in

When you call `.map()` on a Cell array, each item returned is actually a
Cell reference maintains its connection to the Cell system. These proxies have
internal symbols like `Symbol("toCell")` and `Symbol("toOpaqueRef")` attached to
them and a path property that specifies its location in the Cell structure.


We must currently reconstruct the objects to avoid a runtime bug, this is what
we do in the acc.push line below.

```typescript
// ❌ This doesn't work reliably due to a bug in the system:
currentNames.filter((f) => f !== friend)

// ✅ This works correctly:
currentNames.reduce((acc, _, i) => {
  if (!names.key(i).equals(friend as any)) {
    acc.push({ name: currentNames[i].name });
  }
  return acc;
}, [])
```

If we directly push `currentNames[i]`, the proxy symbols get copied into the new
array. When we call `names.set(filtered)`, the Cell system gets confused by
these symbols and throws errors. By explicitly creating a new object with just
the properties we care about, we strip away all the internal metadata and create
a clean object.
:::

Line 13 sets the Cell with our filtered array.

Now we can attach this handler to each list item:

```{code-block} typescript
:label: making_lists_with_onclick
:linenos: true
:emphasize-lines: 3
<ul>
  {state.names.map((friend) => (
    <li onclick={removeItem({ names: state.names, friend })}>
      {friend.name}
    </li>
  ))}
</ul>
```

Line 3 attaches the `removeItem` handler to each list item. We pass in
`state.names` Cell and the `friend` object itself (not an index). This object is
the proxy returned from `.map()`, which the handler can compare using
`.key(i).equals(friend)`.

When you deploy this pattern, clicking on any name will remove it from the list.
The UI automatically updates because the Cell changes.

:::{dropdown} View complete code
:animate: fade-in

```{literalinclude} ./code/making_lists_with_remove.tsx
:language: typescript
```

:::

We've demonstrated:

- How to create a handler that modifies array state
- Use `onclick` on list items to make them interactive
- Pass object references instead of indices to handlers (preferred pattern)
- Use `.key(i).equals(object)` to compare Cell references
- Remove items from a Cell array using `.reduce()` with object reconstruction
- Why object reconstruction is necessary to strip proxy symbols from `.map()` results

## Editing Items

Now we can change the names of our friends. We'll use regular `<input>` elements
to keep things basic.

**Two Approaches:**

1. **Simple approach (bidirectional binding)**: Use `$value` to automatically sync the input with the cell
2. **Handler approach**: Handle the Enter key press to update the value

We'll demonstrate the handler approach here for learning purposes, but in practice, bidirectional binding (approach 1) is often simpler.

The handler checks if the key is Enter and, if so, we grab the string
entered by the user and update it in the names list. We'll be passing the index
so we know which position in the array to update.

First, let's create a handler that updates a name in the array:

```{code-block} typescript
:label: making_lists_edit_handler
:linenos: true
:emphasize-lines: 1-10
const editItem = handler<any, { names: Cell<string[]>, index: number }>(
  (event, { names, index }) => {
    if (event?.key === "Enter") {
      const newValue = event?.target?.value;
      if (newValue !== undefined) {
        const currentNames = names.get();
        names.set(currentNames.toSpliced(index, 1, newValue));
      }
    }
  },
);
```

Line 3 checks if the Enter key was pressed. We only update the array when the
user presses Enter, not on every keystroke.

:::{dropdown} Detailed explanation - The Keyboard Event
:animate: fade-in

The `onkeydown` event provides a KeyboardEvent object with information about the
key press:

```{code-block} typescript
const editItem = handler<any, { names: Cell<string[]>, index: number }>(
  (event, { names, index }) => {
    console.log("Event.type:", event?.type);           // "keydown"
    console.log("Event.key:", event?.key);             // "Enter", "a", "Shift", etc.
    console.log("Event.code:", event?.code);           // "Enter", "KeyA", "ShiftLeft", etc.
    console.log("Event.target.value:", event?.target?.value);  // Current input value
    console.log("Modifier keys:", {
      alt: event?.altKey,
      ctrl: event?.ctrlKey,
      meta: event?.metaKey,
      shift: event?.shiftKey,
    });

    if (event?.key === "Enter") {
      const newValue = event?.target?.value;
      if (newValue !== undefined) {
        const currentNames = names.get();
        names.set(currentNames.toSpliced(index, 1, newValue));
      }
    }
  },
);
```

Useful properties:

- `event.key` - The actual key value ("Enter", "a", "Escape", "ArrowUp")
- `event.code` - The physical key code ("Enter", "KeyA", "Escape", "ArrowUp")
- `event.target.value` - The current text in the input field
- Modifier keys - Detect Ctrl+Enter, Alt+S, etc. for keyboard shortcuts

You could extend this to:

- Save on Enter, cancel on Escape
- Different behavior with Ctrl+Enter vs plain Enter
- Navigate between inputs with arrow keys
:::

Line 4 gets the new value from the input field using `event.target.value`.

Line 7 uses `.toSpliced(index, 1, newValue)` to replace the item at `index` with
`newValue`. The second parameter `1` means "remove 1 item", and the third
parameter is what to insert in its place.

Now let's update our UI to use input fields instead of plain text:

```{code-block} typescript
:label: making_lists_with_inputs
:linenos: true
:emphasize-lines: 4-7
<ul>
  {state.names.map((name, index) => (
    <li>
      <input
        value={name}
        onkeydown={editItem({ names: state.names, index })}
      />
    </li>
  ))}
</ul>
```

Line 4 creates an `<input>` element with the current name as its value.

Line 6 attaches the `onkeydown` event listener, which fires whenever a key is
pressed while the input is focused. Our handler checks for the Enter key.

When you deploy this pattern, you can click on any input field, type a new name,
and press Enter to update it.

### Combining Edit and Remove

Now let's add back the remove functionality from earlier, but this time using a
button next to each input. The `onclick` event works the same way on buttons as
it did on list items:

```{code-block} typescript
:label: making_lists_edit_and_remove
:linenos: true
:emphasize-lines: 2-5
<li>
  <input value={name} onkeydown={editItem({ names: state.names, index })} />
  <button type="button" onclick={removeItem({ names: state.names, index })}>
    Delete
  </button>
</li>
```

The `removeItem` handler is the same one we created earlier - we can reuse it
with the button's `onclick` event.

### Alternative: Bidirectional Binding Approach

As mentioned earlier, for simple value updates, bidirectional binding is often
simpler. Here's how the editing section would look using `$value`:

```typescript
// No edit handler needed!

<li>
  <ct-input $value={state.names[index]} />
  <button type="button" onclick={removeItem({ names: state.names, index })}>
    Delete
  </button>
</li>
```

With `$value`, the input automatically updates the cell when the user types -
no need for an `editItem` handler or Enter key checking! This is the recommended
approach for simple value updates.

:::{dropdown} View complete code
:animate: fade-in

```{literalinclude} ./code/making_lists_with_edit.tsx
:language: typescript
```

:::

We've demonstrated:

- How to use `<input>` elements to edit list items
- Detect specific key presses using the `onkeydown` event and `event.key`
- Update specific items in an array using `.toSpliced()` with a replacement
  value
- Combine multiple interactive features (editing and removing) in one pattern
- Reuse handlers across different UI elements (list items and buttons)

## Reordering Lists with Keybindings

Some friends are more important than others, so let's allow users to reorder the
list. Instead of adding an up and down button next to each item, we'll introduce
the `<ct-keybind>` component that lets us register keyboard shortcuts.

We'll use Ctrl+Up Arrow to move an item up in the list, and Ctrl+Down Arrow to
move it down. First, we need to track which item is currently selected.

In order to keep track of which name is currently selected, we'll add a new
field to our state interface:

```{code-block} typescript
:label: making_lists_selected_index
:linenos: true
:emphasize-lines: 1-4
interface FriendListState {
  names: Default<string[], ["Alice", "Bob", "Charlie", "Diana", "Evan"]>;
  selectedIndex: Default<number, 0>;
}
```

Line 3 adds a `selectedIndex` field to track which list item is currently selected.
We initialize it to `0` (the first item).

Next, we need a handler to update the selected index when a user clicks on a
list item. We pass in the `Cell` which we'll be updating and the index of the
name that the user just clicked on:

```{code-block} typescript
:label: making_lists_select_handler
:linenos: true
:emphasize-lines: 1-4
const selectItem = handler<unknown, { selectedIndex: Cell<number>, index: number }>(
  (_, { selectedIndex, index }) => {
    selectedIndex.set(index);
  },
);
```

This handler simply updates the `selectedIndex` cell when a list item is
clicked.

Now we can create a handler to move items up or down. Instead of creating two
separate handlers, we'll use a `direction` parameter:

```{code-block} typescript
:label: making_lists_move_handler
:linenos: true
:emphasize-lines: 1-19
const moveItem = handler<
  any,
  {
    names: Cell<string[]>;
    selectedIndex: Cell<number>;
    direction: "UP" | "DOWN";
  }
>((_, { names, selectedIndex, direction }) => {
    const index = selectedIndex.get();
    const currentNames = names.get();
    const offset = direction === "UP" ? -1 : 1;
    const newIndex = index + offset;

    if (newIndex >= 0 && newIndex < currentNames.length) {
      const newNames = [...currentNames];
      [newNames[index], newNames[newIndex]] = [newNames[newIndex], newNames[index]];
      names.set(newNames);
      selectedIndex.set(newIndex);
    }
  },
);
```

Lines 1-8 define the handler with a `direction` parameter that can only be
`"UP"` or `"DOWN"`. TypeScript will enforce this. The parameters are formatted
vertically for readability.

Line 11 converts the direction to an offset: `-1` to move up, `1` to move down.

Line 14 checks if the new position is valid (not out of bounds).

Line 16 uses array destructuring to swap the current item with the item at the
new position.

Line 18 updates the selected index to follow the moved item.

Now we can use the `<ct-keybind>` component to register our keyboard shortcuts.
The `<ct-keybind>` component listens for keyboard events at the document level,
so it works regardless of which element has focus.

```{code-block} typescript
:label: making_lists_keybinds
:linenos: true
:emphasize-lines: 1-14
<ct-keybind
  ctrl
  key="ArrowUp"
  onct-keybind={moveItem({
    names: state.names,
    selectedIndex: state.selectedIndex,
    direction: "UP"
  })}
/>
<ct-keybind
  ctrl
  key="ArrowDown"
  onct-keybind={moveItem({
    names: state.names,
    selectedIndex: state.selectedIndex,
    direction: "DOWN"
  })}
/>
```

Line 2 specifies that the Ctrl key must be held.

Line 3 specifies which key to listen for (ArrowUp or ArrowDown).

Lines 4-8 attach our handler to the `onct-keybind` event, passing both Cells and
`direction: "UP"` for the up arrow.

Lines 13-17 do the same for the down arrow, passing `direction: "DOWN"`.

:::{dropdown} More about ct-keybind
:animate: fade-in

The `<ct-keybind>` component supports many options for creating keyboard
shortcuts:

**Modifier Keys**

You can require any combination of modifier keys:

```typescript
// Ctrl+S
<ct-keybind ctrl key="s" onct-keybind={save()} />

// Cmd+K (Meta key is Cmd on Mac, Win on Windows)
<ct-keybind meta key="k" onct-keybind={openSearch()} />

// Shift+Enter
<ct-keybind shift key="Enter" onct-keybind={submitWithShift()} />

// Ctrl+Shift+P
<ct-keybind ctrl shift key="p" onct-keybind={commandPalette()} />

// Alt+Arrow keys
<ct-keybind alt key="ArrowLeft" onct-keybind={navigateBack()} />
```

**Key Codes vs Key Values**

You can use either `key` or `code`:

```typescript
// Use 'key' for the character value
<ct-keybind ctrl key="o" onct-keybind={openFile()} />

// Use 'code' for the physical key position
<ct-keybind ctrl code="KeyO" onct-keybind={openFile()} />
```

The difference: `key` gives you the character (affected by keyboard layout),
while `code` gives you the physical key position (always the same regardless of
layout).

**Behavior Options**

```typescript
// Prevent default browser behavior
<ct-keybind
  ctrl
  key="s"
  prevent-default
  onct-keybind={save()}
/>

// Allow when focused in input fields (default: disabled in inputs)
<ct-keybind
  ctrl
  key="Enter"
  ignore-editable={false}
  onct-keybind={submit()}
/>

// Allow key repeat (when key is held down)
<ct-keybind
  key="ArrowUp"
  allow-repeat
  onct-keybind={scrollUp()}
/>

// Stop event from bubbling
<ct-keybind
  key="Escape"
  stop-propagation
  onct-keybind={closeModal()}
/>
```

**Common Key Names**

- Letter keys: `"a"`, `"b"`, `"c"`, etc.
- Arrow keys: `"ArrowUp"`, `"ArrowDown"`, `"ArrowLeft"`, `"ArrowRight"`
- Special keys: `"Enter"`, `"Escape"`, `"Tab"`, `"Space"`
- Function keys: `"F1"`, `"F2"`, etc.

The `onct-keybind` event receives a detail object containing the event and key
information. :::

Finally, we need to update our list items to be selectable:

```{code-block} typescript
:label: making_lists_selectable_items
:linenos: true
:emphasize-lines: 2
<li onclick={selectItem({ selectedIndex: state.selectedIndex, index })}>
  <input value={name} onkeydown={editItem({ names: state.names, index })} />
  <button type="button" onclick={removeItem({ names: state.names, index })}>Delete</button>
</li>
```

Line 1 adds the `onclick` handler to track which item is selected.

When you deploy this pattern, you can click on any list item to select it, then
press Ctrl+Up or Ctrl+Down to move it in the list.

:::{dropdown} View complete code
:animate: fade-in

```{literalinclude} ./code/making_lists_with_reorder.tsx
:language: typescript
```

:::

We've demonstrated:

- How to track selected items with a cell
- Use array destructuring to swap elements in an array
- Register keyboard shortcuts with the `<ct-keybind>` component
- Listen for modifier keys (Ctrl) combined with arrow keys
- Use TypeScript string literal types to create type-safe direction parameters
- Update multiple cells in response to a single event (names and selectedIndex)

## Adding Items

Of course we love more friends! We'll add an input field to add new friends.
Users can type in a new friend name and it will be added to our friends list.

Let's create a handler that adds the new name to our list when the user presses
Enter. The handler will receive a keyboard event from the input field (just like
we saw with the [editing section earlier](making_lists_with_inputs)) and the
`names` Cell.

```{code-block} typescript
:label: making_lists_add_handler
:linenos: true
:emphasize-lines: 1-10
const addFriend = handler<any, { names: Cell<string[]> }>(
  (event, { names }) => {
    if (event?.key === "Enter") {
      const name = event?.target?.value?.trim();
      if (name) {
        const currentNames = names.get();
        names.set([...currentNames, name]);
      }
    }
  },
);
```

Line 3 checks if the Enter key was pressed.

Line 4 gets the value directly from the input field and removes any extra
whitespace with `.trim()`.

Line 5 checks that the name isn't empty (after trimming).

Line 7 uses the spread operator (`...currentNames`) to create a new array with
all the existing names, then adds the new name at the end.

Now we can add the input field to our UI:

```{code-block} typescript
:label: making_lists_add_input
:linenos: true
:emphasize-lines: 1-5
<div>
  <input
    onkeydown={addFriend({ names: state.names })}
    placeholder="Add a new friend..."
  />
</div>
```

Line 3 attaches our `addFriend` handler to detect when Enter is pressed.

Line 4 adds placeholder text to show users what the input is for.

When you deploy this pattern, you can type a name and press Enter to add it to
the bottom of your friends list.

:::{dropdown} View complete code
:animate: fade-in

```{literalinclude} ./code/making_lists_with_add.tsx
:language: typescript
```

:::

We've demonstrated:

- How adding to a `Cell` array will automatically add elements in a call to
  `.map()`

## Linking Two Lists

You'll often need to move data from one variable to another. In this section
we'll show how this is done by moving friends between two groups -- your
personal friends and your work friends lists.

First, let's create two separate lists and display them side by side. We'll
define a state interface with two arrays:

```{code-block} typescript
:label: making_lists_two_cells
:linenos: true
:emphasize-lines: 1-4
interface FriendListsState {
  personalFriends: Default<string[], ["Alice", "Bob", "Charlie"]>;
  workFriends: Default<string[], ["Diana", "Evan"]>;
}
```

Lines 1-4 define our state interface with two separate friend lists, each
initialized with different names.

Now we can display both lists side by side using a flex layout:

```{code-block} typescript
:label: making_lists_two_columns
:linenos: true
:emphasize-lines: 1,3-9,11-17
<div style="display: flex; gap: 2rem;">
  <div>
    <h3>Personal Friends</h3>
    <ul>
      {state.personalFriends.map((name) => (
        <li>{name}</li>
      ))}
    </ul>
  </div>
  <div>
    <h3>Work Friends</h3>
    <ul>
      {state.workFriends.map((name) => (
        <li>{name}</li>
      ))}
    </ul>
  </div>
</div>
```

Line 1 creates a flex container with a gap between the two lists.

Lines 3-9 display the personal friends list with its own heading.

Lines 11-17 display the work friends list with its own heading.

When you deploy this pattern, you'll see two lists displayed next to each other.

Next, you can add functionality for editing, reordering, and removing items by
reusing the same handlers we've already built. Simply pass the appropriate Cell
(`state.personalFriends` or `state.workFriends`) to the handlers. When a Cell is
modified, the reactive system will update the appropriate list in the UI automatically.

:::{dropdown} View complete code
:animate: fade-in

```{literalinclude} ./code/making_lists_two_lists.tsx
:language: typescript
```

:::

We've demonstrated:

- How to define multiple arrays in a state interface using `Default<>`
- Display multiple lists in the same UI
- Use CSS flexbox for side-by-side layout
- Reuse handlers across different Cells
