import {
  h,
  cell,
  derive,
  handler,
  JSONSchema,
  NAME,
  recipe,
  schema,
  str,
  UI,
} from "commontools";

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
    error: { type: "string", default: "" },
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

const updater = handler<{ delta: number }, { counter: number; error: string }>(
  ({ delta }, state) => {
    if (state.error) {
      console.error("testing throwing an error! in updater");
      throw new Error(state.error);
    }
    state.counter = (state.counter ?? 0) + (delta ?? 1);
  },
);

const updateError = handler<{ detail: { value: string } }, { error: string }>(
  ({ detail }, state) => {
    state.error = detail?.value ?? "";
  },
);

export default recipe(inputSchema, outputSchema, ({ counter, error }) => {
  derive(counter, (counter) => {
    console.log("counter#", counter);
  });
  return {
    [NAME]: str`Counter: ${derive(counter, (counter) => counter)}`,
    [UI]: (
      <div>
        <button type="button" onClick={updater({ counter, error })}>
          Update Counter
        </button>
        <p>If error is set, the update function will throw an error.</p>
        <common-input
          value={error}
          placeholder="Error"
          oncommon-input={updateError({ error })}
        />
        <common-updater $state={counter} integration="counter" />
        <div>
          {counter}
        </div>
      </div>
    ),
    bgUpdater: updater({ counter, error }),
    counter,
  };
});
