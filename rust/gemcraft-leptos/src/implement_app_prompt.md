# Updated Instructions for Functional Reactive Web Framework

When creating examples or applications using this framework, adhere to the following guidelines and constraints:

1. Core Concepts:

   - Use `recipe` for creating components
   - Use `asHandler` for event handlers
   - Use `lift` for derived state and computations
   - Use `setDefault` for default values in recipe props
   - Use `curry` for binding cells to handlers or lifted functions
   - Use `ifElse` for conditional rendering and conditional execution of operations

2. Reactivity:

   - All state changes must be handled through handlers or lifted functions
   - Do not perform direct state manipulations or computations within recipes

3. Recipes:

   - Recipes define the UI and behavior of components
   - Recipe functions receive props as an object and return an object with a `UI` property and optionally a `NAME` property
   - Use the `html` tag function for defining UI templates
   - IMPORTANT: Do not perform any computations, comparisons, or conditional logic directly within recipes

4. Handlers:

   - Handlers created with `asHandler` must be entirely self-contained
   - Do not reference external functions or variables within handlers
   - Handlers receive an event object and a props object as arguments

5. Lifted Functions:

   - Use `lift` for any computations or derived state
   - Lifted functions must be entirely self-contained
   - Do not reference external functions or variables within lifted functions

6. State Management:

   - Use cell objects (e.g., `someState.set(newValue)`) for updating state
   - You can set on subpaths directly. Use `someState.property.set(newValue)` instead of `someState.set({...someState, propery: newValue})`.
   - Access current state values through props in handlers and lifted functions

7. UI Rendering:

   - Use lifted functions for conditional rendering or styling
   - Use `ifElse` for conditional rendering within recipes
   - Do not use ternary operators or direct boolean checks in the UI template

8. Event Binding:

   - Use the `@event=${handler({ props })}` syntax for binding events
   - For inline handlers, use `handler(props, (event, props) => { ... })`

9. Currying:

   - Use `curry` to bind cells to handlers or lifted functions when passing them to child components
   - Example: `childComponent({ onUpdate: curry({ parentState }, updateParentState) })`

10. Imports:

    - Always import necessary functions from "@commontools/common-ui" and "@commontools/common-runtime"

11. Conditional Execution:

    - Use `ifElse` for conditional execution of operations, especially when dealing with asynchronous or expensive computations
    - Example: `const { partial, pending } = ifElse(condition, operation(), defaultValue)`

12. Data Generation:

    - When using `generateData`, prefer using only the `partial` result for a streaming experience
    - Handle both `pending` and `partial` states to provide real-time updates to the user

13. Derived State:

    - Use lifted functions to derive state from `partial` results
    - Example: `const derivedState = lift(({ partial }) => processPartial(partial))`

14. Async Operations:

    - Treat async operations as streams of data using `partial` results
    - Update UI in real-time as `partial` data becomes available

15. Error Handling:
    - Implement error handling within lifted functions that process `partial` data
    - Provide meaningful feedback to users when errors occur

Strategies for Avoiding Computations in Recipes:

1. Factor out computations into lifted functions:

   ```typescript
   const getCountCategory = lift(({ count }) => (count > 5 ? "High" : "Low"));
   // In recipe:
   const category = getCountCategory({ count });
   ```

2. Use `ifElse` for conditional rendering:

   ```typescript
   ifElse(isEnabled, enabledComponent(), disabledComponent());
   ```

3. Create lifted functions for complex conditions:

   ```typescript
   const isEvenAndEnabled = lift(
     ({ count, isEnabled }) => count % 2 === 0 && isEnabled
   );
   // In recipe:
   const evenAndEnabled = isEvenAndEnabled({ count, isEnabled });
   ```

4. Use lifted functions for string interpolation:
   ```typescript
   const getItemText = lift(
     ({ count }) => `${count} item${count !== 1 ? "s" : ""}`
   );
   // In recipe:
   const itemText = getItemText({ count });
   ```

Example of a correct recipe using these concepts:

```typescript
import { html } from "@commontools/common-ui";
import {
  recipe,
  asHandler,
  lift,
  NAME,
  WithDefault,
  curry,
  ifElse,
} from "@commontools/common-runtime";

const updateCount = asHandler((event, { count }) => {
  count.set(count + 1);
});

const getButtonText = lift(
  ({ count }) => `Clicked ${count} time${count === 1 ? "" : "s"}`
);

export const counterExample = recipe<{
  count: number;
  isEnabled: boolean;
}>("counter example", ({ count, isEnabled }) => {
  count.setDefault(0);
  isEnabled.setDefault(true);

  const buttonText = getButtonText({ count });

  const { partial, pending } = ifElse(
    isEnabled,
    generateData({
      prompt: "Generate a fun fact about the number {{ count }}",
      schema: { type: "object", properties: { fact: { type: "string" } } },
      vars: { count },
    }),
    { partial: { fact: null }, pending: false }
  );

  const funFact = lift(({ partial }) =>
    partial && partial.fact ? partial.fact : "Generating fun fact..."
  );
  const displayFact = funFact({ partial });

  return {
    UI: html`
      <vstack gap="sm">
        ${ifElse(
          isEnabled,
          html`
            <common-button @click=${updateCount({ count })}>
              ${buttonText}
            </common-button>
            <p>${displayFact}</p>
          `,
          html`<p>Counter is disabled</p>`
        )}
      </vstack>
    `,
    [NAME]: "Counter Example",
  };
});
```

This example demonstrates the use of `recipe`, `asHandler`, `lift`, `ifElse`, and `generateData` in accordance with the updated guidelines. It shows how to handle conditional rendering, async operations, and derived state in a functional reactive manner.