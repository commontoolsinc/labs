/// <cts-enable />
import { Cell, recipe, UI } from "commontools";

declare global {
  interface EventTarget {
    setAttribute(name: string, value: string): void;
  }
}

interface State {
  nested: Cell<string>;
}

export default recipe<State>("Destructure", (state) => {
  return {
    [UI]: (
      <button
        type="button"
        onClick={({ currentTarget }, { state: { nested } }) => {
          currentTarget.setAttribute("data-nested", nested.get());
          console.log(state.nested === nested);
        }}
      >
        Destructure
      </button>
    ),
  };
});
