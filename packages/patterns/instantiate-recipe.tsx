/// <cts-enable />
import {
  Cell,
  Default,
  handler,
  NAME,
  navigateTo,
  recipe,
  str,
  UI,
} from "commontools";

interface RecipeState {
  value: Default<number, 0>;
}

const increment = handler<unknown, { value: Cell<number> }>((_, state) => {
  state.value.set(state.value.get() + 1);
});

const decrement = handler((_, state: { value: Cell<number> }) => {
  state.value.set(state.value.get() - 1);
});

function previous(value: number) {
  return value - 1;
}

function nth(value: number) {
  if (value === 1) {
    return "1st";
  }
  if (value === 2) {
    return "2nd";
  }
  if (value === 3) {
    return "3rd";
  }
  return `${value}th`;
}

export const Counter = recipe<RecipeState>("Counter", (state) => {
  return {
    [NAME]: str`Simple counter: ${state.value}`,
    [UI]: (
      <div>
        <ct-button onClick={decrement(state)}>
          dec to {previous(state.value)}
        </ct-button>
        <span id="counter-result">
          Counter is the {nth(state.value)} number
        </span>
        <ct-button onClick={increment({ value: state.value })}>
          inc to {state.value + 1}
        </ct-button>
      </div>
    ),
    value: state.value,
  };
});

interface FactoryInput {
  // Provided by the shell; not used directly here
  allCharms: Default<unknown[], []>;
}

// No additional outputs beyond name and UI
type FactoryOutput = {
  [NAME]: string;
  [UI]: any;
};

type InputEvent = { detail: { message: string } };

const newCounter = handler<InputEvent, Record<string, never>>((_, __) => {
  const charm = Counter({ value: Math.round(Math.random() * 10) });
  return navigateTo(charm);
});

export default recipe<FactoryInput, FactoryOutput>(
  "Counter Factory",
  (_) => {
    return {
      [NAME]: "Counter Factory",
      [UI]: (
        <div>
          <ct-message-input
            button-text="Add"
            placeholder="New counter"
            appearance="rounded"
            onct-send={newCounter({})}
          />
        </div>
      ),
    };
  },
);
