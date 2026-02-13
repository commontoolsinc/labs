---
title: Using Defaults for Cells
short_title: Using Defaults
description: Using Default<> to automatically create and initialize Cells
subject: Tutorial
authors:
  - name: Ellyse Cedeno
    email: ellyse@common.tools
keywords: commontools, state, Cell, Default, pattern inputs
abstract: |
  In this section, we learn how to use Default<> to automatically create and initialize
  Cells for pattern inputs. This is the recommended pattern for managing pattern state.
---

# Using Defaults for Cells

## Introduction

In previous chapters, we used `cell()` to create and manage state. While this
works fine for learning, there's a better way to handle state in patterns: using
`Default<>` in your pattern's input interface.

We introduced `cell()` first to help you understand how Cells work without
learning too many concepts at once. Now that you're comfortable with Cells,
let's learn the recommended pattern.

**Important:** For pattern inputs, you should almost always use `Default<>`
instead of `cell()`.

## Why Use Default<>?

`Default<Type, InitialValue>` provides three key benefits:

1. **Automatic Cell creation** - The runtime creates the Cell for you
2. **Default values** - Specifies what value to use if none is provided
3. **Schema generation** - Generates proper JSON schema for your pattern
4. **Works** - also at the time of this writing, `cell()` has some bugs, this is
   a huge reason to avoid it. When you use `Default<>` in a pattern's input
   interface, the Common Tools runtime automatically creates a Cell and
   initializes it with your default value.

## A Simple Counter with Default

Let's create a counter using `Default<>`. Compare this to creating a Cell
manually:

**Using cell() (what we did before):**

```typescript
export default pattern("Counter", () => {
  const count = cell<number>(0); // Manual Cell creation

  return {
    [UI]: <div>{count}</div>,
  };
});
```

**Using Default<> (recommended):**

```typescript
interface CounterState {
  count: Default<number, 100>;
}

export default pattern<CounterState>("Counter", (state) => {
  // state.count is already a Cell<number> initialized to 100

  return {
    [UI]: <div>{state.count}</div>,
    count: state.count, // Export the cell
  };
});
```

Let's build a complete counter with an increment button:

```{code-block} typescript
:label: using_defaults_counter
:linenos: true
:emphasize-lines: 11-13,21,26,31
/// <cts-enable />
import {
  Default,
  h,
  handler,
  pattern,
  UI,
  type Cell,
} from "commontools";

interface CounterState {
  count: Default<number, 100>;
}

const increment = handler<unknown, { count: Cell<number> }>(
  (_, { count }) => {
    count.set(count.get() + 1);
  },
);

export default pattern<CounterState>("Counter with Default", (state) => {
  return {
    [UI]: (
      <div>
        <h2>Count: {state.count}</h2>
        <button type="button" onclick={increment({ count: state.count })}>
          Increment
        </button>
      </div>
    ),
    count: state.count,
  };
});
```

**Lines 11-13** define the input interface with `Default<number, 100>`. This
tells the runtime:

- Create a Cell that holds a number
- Initialize it to 100

**Line 21** receives `state` which has a `count` property that's already a
`Cell<number>`.

**Line 26** passes the Cell to the handler, just like before.

**Line 31** exports the Cell so other patterns can use it.

:::{dropdown} View complete code :animate: fade-in

```{literalinclude} ./code/using_defaults_counter.tsx
:language: typescript
```

:::

When you deploy this pattern, the counter starts at 100. If someone creates an
instance of this pattern and provides a different value, it will start there
instead.

## Using Default with Arrays

Arrays are common in patterns. Let's create a todo list that starts with a few
items already in it:

```{code-block} typescript
:label: using_defaults_array
:linenos: true
:emphasize-lines: 11-13
/// <cts-enable />
import {
  Default,
  h,
  handler,
  pattern,
  UI,
  type Cell,
} from "commontools";

interface TodoListState {
  items: Default<string[], ["Pay bill", "Write code", "Dinner with friends"]>;
}
```

**Line 12** specifies
`Default<string[], ["Pay bill", "Write code", "Dinner with friends"]>`:

- First parameter: The type is an array of strings
- Second parameter: The default value is an array with three todo items already
  in it

Now let's add a handler to add new items to the list:

```{code-block} typescript
:label: using_defaults_add_item
:linenos: true
:emphasize-lines: 1-11
const addItem = handler<
  { detail: { message: string } },
  { items: Cell<string[]> }
>(
  (event, { items }) => {
    const value = event.detail.message?.trim();
    if (value) {
      const currentItems = items.get();
      items.set([...currentItems, value]);
    }
  },
);
```

This handler receives an event with `{detail: {message: string}}` - this is the
shape we'll need for the `<ct-message-input>` component we'll use later. The
handler gets the message text, trims whitespace, and adds it to the array if
it's not empty.

Here's the complete todo list pattern:

```{code-block} typescript
:label: using_defaults_todo_complete
:linenos: true
:emphasize-lines: 11-13,28,33-36
/// <cts-enable />
import {
  Default,
  h,
  handler,
  pattern,
  UI,
  type Cell,
} from "commontools";

interface TodoListState {
  items: Default<string[], ["Pay bill", "Write code", "Dinner with friends"]>;
}

const addItem = handler<
  { detail: { message: string } },
  { items: Cell<string[]> }
>(
  (event, { items }) => {
    const value = event.detail.message?.trim();
    if (value) {
      const currentItems = items.get();
      items.set([...currentItems, value]);
    }
  },
);

export default pattern<TodoListState>("Todo List", (state) => {
  return {
    [UI]: (
      <div>
        <h2>My Todos</h2>
        <ct-message-input
          name="Add"
          placeholder="Add a todo..."
          onct-send={addItem({ items: state.items })}
        />
        <ul>
          {state.items.map((item) => (
            <li>{item}</li>
          ))}
        </ul>
      </div>
    ),
    items: state.items,
  };
});
```

**Lines 11-13** define the state with three todo items as the default.

**Line 28** receives `state` which has an `items` property that's already a
`Cell<string[]>`.

**Lines 33-36** use the `<ct-message-input>` component for input, which
provides a text field with a submit button. The `onct-send` event fires when
the user submits.

**Lines 39-41** use `.map()` to render each item in the list.

:::{dropdown} View complete code :animate: fade-in

```{literalinclude} ./code/using_defaults_array.tsx
:language: typescript
```

:::

## Using Default with Complex Objects

`Default<>` works with any type, including complex objects. Let's create a game
stats tracker:

```{code-block} typescript
:label: using_defaults_object_type
:linenos: true
:emphasize-lines: 1-5,7-17
interface Player {
  playerName: string;
  score: number;
  level: number;
}

interface GameState {
  stats: Default<
    Player,
    {
      playerName: "Player 1";
      score: 500;
      level: 10;
    }
  >;
}
```

**Lines 1-5** define the TypeScript interface for our game stats.

**Lines 7-17** use `Default<>` with:

- First parameter: The `Player` type
- Second parameter: An object with default values for each property

Let's create handlers to update the stats:

```{code-block} typescript
:label: using_defaults_object_handlers
:linenos: true
:emphasize-lines: 1-6,8-14
const incrementScore = handler<unknown, { stats: Cell<Player> }>(
  (_, { stats }) => {
    const currentScore = stats.key("score").get();
    stats.key("score").set(currentScore + 10);
  },
);

const levelUp = handler<unknown, { stats: Cell<Player> }>(
  (_, { stats }) => {
    const currentLevel = stats.key("level").get();
    stats.key("level").set(currentLevel + 1);
  },
);
```

Both handlers use the `.key()` pattern to update individual properties:

1. Use `stats.key("propertyName")` to access a specific property as a Cell
2. Call `.get()` on that property Cell to read the current value
3. Call `.set()` on that property Cell to update just that property

This approach is cleaner than reconstructing the entire object and avoids issues
with the spread operator. Notice that `levelUp` only updates the level - it
doesn't touch the score, which continues to accumulate.

Here's the complete game stats pattern:

```{code-block} typescript
:label: using_defaults_object_complete
:linenos: true
:emphasize-lines: 11-24,42-53
/// <cts-enable />
import {
  Default,
  h,
  handler,
  pattern,
  UI,
  type Cell,
} from "commontools";

interface Player {
  playerName: string;
  score: number;
  level: number;
}

interface GameState {
  stats: Default<
    Player,
    {
      playerName: "Player 1";
      score: 500;
      level: 10;
    }
  >;
}

const incrementScore = handler<unknown, { stats: Cell<GameStats> }>(
  (_, { stats }) => {
    const currentScore = stats.key("score").get();
    stats.key("score").set(currentScore + 10);
  },
);

const levelUp = handler<unknown, { stats: Cell<Player> }>(
  (_, { stats }) => {
    const currentLevel = stats.key("level").get();
    stats.key("level").set(currentLevel + 1);
  },
);

export default pattern<GameState>("Game Stats with Default", (state) => {
  return {
    [UI]: (
      <div>
        <h2>Game Stats</h2>
        <p>Player: {state.stats.playerName}</p>
        <p>Level: {state.stats.level}</p>
        <p>Score: {state.stats.score}</p>
        <button type="button" onclick={incrementScore({ stats: state.stats })}>
          Add 10 Points
        </button>
        <button type="button" onclick={levelUp({ stats: state.stats })}>
          Level Up
        </button>
      </div>
    ),
    stats: state.stats,
  };
});
```

**Lines 11-24** define both the stats type and the default state.

**Lines 50-52** access properties of the stats object in the UI. Notice we can
access nested properties like `state.stats.playerName` directly in JSX.

**Lines 53-58** pass the entire stats Cell to handlers that update different
properties.

:::{dropdown} View complete code :animate: fade-in

```{literalinclude} ./code/using_defaults_object.tsx
:language: typescript
```

:::

When you deploy this pattern, it starts with the default player name, level 10,
and score 500.

## Key Takeaways

We've learned how to use `Default<>` to create Cells automatically:

**For simple values:**

```typescript
interface State {
  count: Default<number, 100>;
}
```

**For arrays:**

```typescript
interface State {
  items: Default<string[], ["Pay bill", "Write code", "Dinner with friends"]>;
}
```

**For objects:**

```typescript
interface State {
  stats: Default<
    Player,
    { playerName: "Player 1"; score: 500; level: 10 }
  >;
}
```

In the next chapter, we'll explore working with lists in more detail, including
adding, removing, and editing items.
