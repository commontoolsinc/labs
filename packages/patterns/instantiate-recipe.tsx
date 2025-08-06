/// <cts-enable />
import {
  Cell,
  Default,
  compileAndRun,
  derive,
  h,
  handler,
  ifElse,
  JSONSchema,
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


const InputSchema = {
  type: "object",
  properties: {
    allCharms: {
      type: "array",
      items: {
        type: "object",
        asCell: true,
      },
    },
  },
  required: ["allCharms"],
} as const satisfies JSONSchema;

// Define output schema
const OutputSchema = {
  type: "object",
  properties: {},
  required: [],
} as const satisfies JSONSchema;

const newCounter = handler(
  { type: 'object', properties: { detail: { type: 'object', properties: { message: { type: 'string' } } } } },
  { type: 'object' },
  (e, _) => {
    const charm = Counter({ value: Math.round(Math.random()*10) });
    return navigateTo(charm);
  },
);

export default recipe(InputSchema, OutputSchema, ({ }) => {
  return {
    [NAME]: "Counter Factory",
    [UI]: (
      <div>
        <ct-message-input
          name="Add"
          placeholder="New counter"
          appearance="rounded"
          onct-send={newCounter({ })}
        />
      </div>
    ),
  };
});
