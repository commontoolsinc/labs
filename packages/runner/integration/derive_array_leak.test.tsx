/// <cts-enable />
import {
  Cell,
  Default,
  derive,
  handler,
  NAME,
  pattern,
  str,
  Stream,
  UI,
} from "commontools";

// How many times to increment per click
const INCREMENTS_PER_CLICK = 50;

interface PatternState {
  value: Default<number, 0>;
}

interface PatternOutput {
  value: Default<number, 0>;
  increment: Stream<void>;
  decrement: Stream<void>;
}

// Inline handlers to avoid import resolution issues
const increment = handler<
  void,
  { value: Cell<number> }
>(
  (_args, state) => {
    // Increment multiple times per click to trigger derive() multiple times
    for (let i = 0; i < INCREMENTS_PER_CLICK; i++) {
      state.value.set(state.value.get() + 1);
    }
  },
);

const decrement = handler<
  void,
  { value: Cell<number> }
>(
  (_args, state) => {
    state.value.set(state.value.get() - 1);
  },
);

function nth(value: number) {
  if (value === 1) return "1st";
  if (value === 2) return "2nd";
  if (value === 3) return "3rd";
  return `${value}th`;
}

function previous(value: number) {
  return value - 1;
}

export default pattern<PatternState, PatternOutput>((state) => {
  const array = derive(state.value, (value: number) => {
    // Clamp to prevent negative array length
    const length = Math.max(0, value);
    return new Array(length).fill(0);
  });
  return {
    [NAME]: str`Simple counter: ${state.value}`,
    [UI]: (
      <div>
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
        <div>
          {array.map((v: number, i: number) => <span key={i}>{v % 10}</span>)}
        </div>
      </div>
    ),
    value: state.value,
    increment: increment(state),
    decrement: decrement(state),
  };
});
