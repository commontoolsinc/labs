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

Whatever it is you are building, you'll very likely need to display a list at some
point. We'll go over how to do that within recipes.

Lists are essential for displaying collections of data—whether it's a todo list,
a contact list, or a feed of messages.

## Our First List

Let's start simple: we'll create a list of our friends.
We'll make an array of 5 names and store that in a cell.

We'll need the following imports for this recipe:

```{code-block} typescript
:label: making_lists_imports
:linenos: false
:emphasize-lines:
/// <cts-enable />
import {
  cell,
  h,
  recipe,
  UI,
} from "commontools";
```

Now we can create a cell to hold our list. We'll initialize it with an empty array,
then set it with our friend names:

```{code-block} typescript
:label: making_lists_cell
:linenos: true
:emphasize-lines: 1,4-10
const names = cell<string[]>([]);

// Initialize with 5 hardcoded names
names.set([
  "Alice",
  "Bob",
  "Charlie",
  "Diana",
  "Evan",
]);
```

On line 1, we create a `Cell` that holds an array of strings.
Lines 4-10 set the cell with our friend names.

With our names in hand, we can now display them in the recipe's [UI].
We'll use the `.map()` function to iterate over each name and render it as a list item:

```{code-block} typescript
:label: making_lists_map
:linenos: true
:emphasize-lines: 3-5
<ul>
  {names.map((name, index) => (
    <li>{name}</li>
  ))}
</ul>
```

The `.map()` function (line 3) iterates over each name in our array.
For each name, we create an `<li>` element (line 4) that displays the name.

Here's what the complete recipe looks like:

```{code-block} typescript
:label: making_lists_complete
:linenos: true
:emphasize-lines: 10,13-21,27-30
/// <cts-enable />
import {
  cell,
  h,
  recipe,
  UI,
} from "commontools";

export default recipe("making lists - simple", () => {
  const names = cell<string[]>([]);

  // Initialize with 5 hardcoded names
  names.set([
    "Alice",
    "Bob",
    "Charlie",
    "Diana",
    "Evan",
  ]);

  return {
    [UI]: (
      <div>
        <h2>My Friends</h2>
        <ul>
          {names.map((name, index) => (
            <li>{name}</li>
          ))}
        </ul>
      </div>
    ),
  };
});
```

When you deploy this recipe, you should see a simple list displaying your five friend names.

:::{dropdown} View complete code
:animate: fade-in

```{literalinclude} ./code/making_lists_simple.tsx
:language: typescript
```
:::

We've demonstrated the following concepts:
* How to create a `Cell` that holds an array of strings
* Use `.set()` to populate the array with values
* Use `.map()` to iterate over the array and render list items
* Create a simple unordered list in the `[UI]`

:::{admonition} Why use a Cell?
Even though we initialize the array with static values, using a `Cell` makes our
list reactive. This means if we later add functionality to modify the list
(like adding or removing names), the UI will automatically update.
:::


## Removing Items

In this section we'll build a feature to remove friends from our list.
We'll add an onclick listener to the list item and our handler will delete
the item from the list.

First, we need to import the `handler` function:

```{code-block} typescript
:label: making_lists_imports_handler
:linenos: false
:emphasize-lines: 4
import {
  cell,
  h,
  handler,
  recipe,
  UI,
} from "commontools";
```

Next, we'll create a handler that removes an item from the array. The handler
will receive the index of the item to remove:

```{code-block} typescript
:label: making_lists_remove_handler
:linenos: true
:emphasize-lines: 1-6
const removeItem = handler<unknown, { names: Cell<string[]>, index: number }>(
  (_, { names, index }) => {
    const currentNames = names.get();
    names.set(currentNames.toSpliced(index, 1));
  },
);
```

On line 1, we define the handler signature. The first type parameter is `unknown`
because we don't need any information from the click event. The second type
parameter specifies that we need the `names` Cell and the `index` of the item
to remove.

:::{dropdown} Detailed explanation - The Event Object
:animate: fade-in

Even though we use `_` to ignore the event parameter, the handler actually receives
a full MouseEvent object when the user clicks. This event contains useful information:

```typescript
const removeItem = handler<any, { names: Cell<string[]>, index: number }>(
  (event, { names, index }) => {
    console.log("Event.type:", event?.type);              // "click"
    console.log("Event.detail:", event?.detail);          // Click count
    console.log("Modifier keys:", {
      alt: event?.altKey,      // true if Alt key held
      ctrl: event?.ctrlKey,    // true if Ctrl key held
      meta: event?.metaKey,    // true if Meta/Cmd key held
      shift: event?.shiftKey,  // true if Shift key held
    });

    // Your handler logic here
    const currentNames = names.get();
    names.set(currentNames.toSpliced(index, 1));
  },
);
```

You can use the event to implement features like:
- Delete with confirmation only when holding Shift
- Different actions based on modifier keys
- Double-click detection using `event.detail`

For our simple delete, we don't need the event information, so we use `_` as
a placeholder.
:::

Line 3 gets the current array from the cell.

Line 4 uses `.toSpliced()` to create a new array with the item at `index` removed,
then sets the cell with this new array. The `.toSpliced()` method is a non-mutating
version of `.splice()` that returns a new array, which triggers the UI to update.

Now we can attach this handler to each list item:

```{code-block} typescript
:label: making_lists_with_onclick
:linenos: true
:emphasize-lines: 3
<ul>
  {names.map((name, index) => (
    <li onclick={removeItem({ names, index })}>
      {name}
    </li>
  ))}
</ul>
```

Line 3 attaches the `removeItem` handler to each list item. We pass in both
the `names` cell and the current `index`.

When you deploy this recipe, clicking on any name will remove it from the list.
The UI automatically updates because the `names` cell changes.

:::{dropdown} View complete code
:animate: fade-in

```{literalinclude} ./code/making_lists_with_remove.tsx
:language: typescript
```
:::

We've demonstrated:
* How to create a handler that modifies array state
* Use `onclick` on list items to make them interactive
* Remove items from a cell array using `.get()`, `.toSpliced()`, and `.set()`
* Pass both the cell and item-specific data (index) to handlers

## Editing Items

Now we can change the names of our friends. We'll use regular `<input>` elements
to keep things basic. When the user presses Enter, our `onkeydown` event listener
kicks in and calls our handler which will modify the friend's name.

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
`newValue`. The second parameter `1` means "remove 1 item", and the third parameter
is what to insert in its place.

Now let's update our UI to use input fields instead of plain text:

```{code-block} typescript
:label: making_lists_with_inputs
:linenos: true
:emphasize-lines: 4-7
<ul>
  {names.map((name, index) => (
    <li>
      <input
        value={name}
        onkeydown={editItem({ names, index })}
      />
    </li>
  ))}
</ul>
```

Line 4 creates an `<input>` element with the current name as its value.

Line 6 attaches the `onkeydown` event listener, which fires whenever a key is
pressed while the input is focused. Our handler checks for the Enter key.

When you deploy this recipe, you can click on any input field, type a new name,
and press Enter to update it.

### Combining Edit and Remove

Now let's add back the remove functionality from earlier, but this time using a
button next to each input. The `onclick` event works the same way on buttons as it
did on list items:

```{code-block} typescript
:label: making_lists_edit_and_remove
:linenos: true
:emphasize-lines: 2-5
<li>
  <input value={name} onkeydown={editItem({ names, index })} />
  <button onclick={removeItem({ names, index })}>
    Delete
  </button>
</li>
```

The `removeItem` handler is the same one we created earlier - we can reuse it with
the button's `onclick` event.

:::{dropdown} View complete code
:animate: fade-in

```{literalinclude} ./code/making_lists_with_edit.tsx
:language: typescript
```
:::

We've demonstrated:
* How to use `<input>` elements to edit list items
* Detect specific key presses using the `onkeydown` event and `event.key`
* Update specific items in an array using `.toSpliced()` with a replacement value
* Combine multiple interactive features (editing and removing) in one recipe
* Reuse handlers across different UI elements (list items and buttons)

## Reordering Lists with Keybindings

Some friends are more important than others, so let's allow users to reorder the list.
Instead of adding an up and down button next to each item, we'll introduce the `<ct-keybind>` component that lets us register keyboard shortcuts.

We'll use Ctrl+Up Arrow to move an item up in the list, and Ctrl+Down Arrow to move it down. First, we need to track which item is currently selected.

In order to keep track of which name is currently selected, we'll create a new `Cell` that stores the index of the selected name:

```{code-block} typescript
:label: making_lists_selected_index
:linenos: true
:emphasize-lines: 2,4
const names = cell<string[]>([]);
const selectedIndex = cell<number>(0);

names.set(["Alice", "Bob", "Charlie", "Diana", "Evan"]);
```

Line 2 creates a cell to track which list item is currently selected. We initialize it to `0` (the first item).

Next, we need a handler to update the selected index when a user clicks on a list item.
We pass in the `Cell` which we'll be updating and the index of the name that the user just clicked on:

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

This handler simply updates the `selectedIndex` cell when a list item is clicked.

Now we can create a handler to move items up or down. Instead of creating two separate handlers, we'll use a `direction` parameter:

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

Lines 1-8 define the handler with a `direction` parameter that can only be `"UP"` or `"DOWN"`. TypeScript will enforce this. The parameters are formatted vertically for readability.

Line 11 converts the direction to an offset: `-1` to move up, `1` to move down.

Line 14 checks if the new position is valid (not out of bounds).

Line 16 uses array destructuring to swap the current item with the item at the new position.

Line 18 updates the selected index to follow the moved item.

Now we can use the `<ct-keybind>` component to register our keyboard shortcuts.
The `<ct-keybind>` component listens for keyboard events at the document level, so it works regardless of which element has focus.

```{code-block} typescript
:label: making_lists_keybinds
:linenos: true
:emphasize-lines: 1-10
<ct-keybind
  ctrl
  key="ArrowUp"
  onct-keybind={moveItem({ names, selectedIndex, direction: "UP" })}
/>
<ct-keybind
  ctrl
  key="ArrowDown"
  onct-keybind={moveItem({ names, selectedIndex, direction: "DOWN" })}
/>
```

Line 2 specifies that the Ctrl key must be held.

Line 3 specifies which key to listen for (ArrowUp or ArrowDown).

Line 4 attaches our handler to the `onct-keybind` event, passing `direction: "UP"` for the up arrow.

Line 9 does the same for the down arrow, passing `direction: "DOWN"`.

:::{dropdown} More about ct-keybind
:animate: fade-in

The `<ct-keybind>` component supports many options for creating keyboard shortcuts:

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

The difference: `key` gives you the character (affected by keyboard layout), while `code` gives you the physical key position (always the same regardless of layout).

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

The `onct-keybind` event receives a detail object containing the event and key information.
:::

Finally, we need to update our list items to be selectable:

```{code-block} typescript
:label: making_lists_selectable_items
:linenos: true
:emphasize-lines: 2
<li onclick={selectItem({ selectedIndex, index })}>
  <input value={name} onkeydown={editItem({ names, index })} />
  <button onclick={removeItem({ names, index })}>Delete</button>
</li>
```

Line 1 adds the `onclick` handler to track which item is selected.

When you deploy this recipe, you can click on any list item to select it, then press Ctrl+Up or Ctrl+Down to move it in the list.

:::{dropdown} View complete code
:animate: fade-in

```{literalinclude} ./code/making_lists_with_reorder.tsx
:language: typescript
```
:::

We've demonstrated:
* How to track selected items with a cell
* Use array destructuring to swap elements in an array
* Register keyboard shortcuts with the `<ct-keybind>` component
* Listen for modifier keys (Ctrl) combined with arrow keys
* Use TypeScript string literal types to create type-safe direction parameters
* Update multiple cells in response to a single event (names and selectedIndex) 
