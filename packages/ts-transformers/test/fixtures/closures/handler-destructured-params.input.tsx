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
        // Convenience pattern: transformer handles destructured handler params
        // @ts-expect-error Testing convenience pattern: handler with destructured event and state params
        onClick={({ currentTarget }: { currentTarget: EventTarget }, { state: { nested } }: { state: { nested: Cell<string> } }) => {
          currentTarget.setAttribute("data-nested", nested.get());
          console.log(state.nested === nested);
        }}
      >
        Destructure
      </button>
    ),
  };
});
