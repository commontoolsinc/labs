import { h } from "@commontools/html";
import {
  derive,
  handler,
  ifElse,
  JSONSchema,
  lift,
  NAME,
  recipe,
  schema,
  str,
  UI,
} from "@commontools/builder/interface";

const inputSchema = schema({
  type: "object",
  properties: {
    counter: {
      type: "integer",
      default: 0,
      asCell: true,
    },
  },
  default: { counter: 0 },
});

const outputSchema = schema({
  type: "object",
  properties: {},
});

const incCounter = handler({}, {
  type: "object",
  properties: {
    counter: {
      type: "integer",
      asCell: true,
    },
  },
}, (_event, state) => {
  if (state.counter) {
    const current_count = state.counter.value;
    console.log("current count=", current_count);
    state.counter.set(current_count + 1);
  } else {
    console.log("counter is undefined, ignoring");
  }
});

const isEven = lift(({ counter }) => {
  return counter % 2;
});

export default recipe(
  inputSchema,
  outputSchema,
  ({ counter }) => {
    const isEvenVal = isEven({ counter });
    derive(counter, (c) => {
      console.log("derive counter: ", c);
    });
    return {
      [NAME]: str`counter: ${counter}`,
      [UI]: (
        <div>
          {ifElse(
            isEvenVal,
            <p>counter is odd : {counter}</p>,
            <p>counter is even : {counter}</p>,
          )}
          <p />
          <button
            type="button"
            onClick={incCounter({ counter })}
          >
            |click me|
          </button>
        </div>
      ),
    };
  },
);
