import { h } from "@commontools/html";
import {
  cell,
  derive,
  handler,
  JSONSchema,
  NAME,
  recipe,
  schema,
  str,
  UI,
} from "@commontools/builder";

const updaterSchema = {
  type: "object",
  properties: {
    delta: { type: "number", default: 1 },
  },
  title: "Update Counter",
  description: "Update the counter by `delta`.",
} as const satisfies JSONSchema;

const inputSchema = schema({
  type: "object",
  properties: {
    counter: { type: "number", default: 0 },
  },
});

const outputSchema = {
  type: "object",
  properties: {
    counter: { type: "number", asCell: true },
    bgUpdater: {
      asStream: true,
      ...updaterSchema,
    },
  },
} as const satisfies JSONSchema;

const updater = handler<{ delta: number }, { counter: number }>(
  ({ delta }, state) => {
    console.log("updating counter", delta, state);
    state.counter = (state.counter ?? 0) + (delta ?? 1);
  },
);

export default recipe(inputSchema, outputSchema, ({ counter }) => {
  derive(counter, (counter) => {
    console.log("counter#", counter);
  });
  return {
    [NAME]: str`Counter: ${derive(counter, (counter) => counter)}`,
    [UI]: (
      <div>
        <button type="button" onClick={updater({ counter })}>
          Update Counter
        </button>
        <common-updater $state={counter} integration="counter" />
        <div>
          {counter}
        </div>
      </div>
    ),
    bgUpdater: updater({ counter }),
    counter,
  };
});
