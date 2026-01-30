/// <cts-enable />
import {
  computed,
  Default,
  handler,
  NAME,
  navigateTo,
  pattern,
  UI,
  Writable,
} from "commontools";

interface RecipeState {
  value: Default<number, 0>;
}

const increment = handler<unknown, { value: Writable<number> }>((_, state) => {
  state.value.set(state.value.get() + 1);
});

const decrement = handler((_, state: { value: Writable<number> }) => {
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

export const Counter = pattern<RecipeState>((state) => {
  return {
    [NAME]: computed(() => `Simple counter: ${state.value}`),
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
  allPieces: Default<unknown[], []>;
}

// No additional outputs beyond name and UI
type FactoryOutput = {
  [NAME]: string;
  [UI]: any;
};

type InputEvent = { detail: { message: string } };

const newCounter = handler<InputEvent, Record<string, never>>((_, __) => {
  const piece = Counter({
    value: Math.round(
      (crypto.getRandomValues(new Uint32Array(1))[0] / 0xFFFFFFFF) * 10,
    ),
  });
  return navigateTo(piece);
});

export default pattern<FactoryInput, FactoryOutput>((_) => {
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
});
