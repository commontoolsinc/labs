import { h } from "@commontools/html";
import {
  cell,
  derive,
  handler,
  JSONSchema,
  NAME,
  recipe,
  UI,
} from "@commontools/builder";

const inputSchema: JSONSchema = {
  type: "object",
  properties: {
    values: { type: "array", items: { type: "string" } },
  },
};

const outputSchema: JSONSchema = {
  type: "object",
  properties: {
    values: { type: "array", items: { type: "string" } },
    updater: { asCell: true, type: "action" },
  },
};

const updater = handler<{ newValues: string[] }, { values: string[] }>(
  (event, state) => {
    if (!state.values) state.values = [];
    console.log("updating values", event);
    event?.newValues?.forEach((value) => {
      console.log("adding value", value);
      state.values.push(value);
    });
  },
);

const adder = handler<{}, { values: string[] }>((_, state) => {
  console.log("adding a value");
  if (!state.values) state.values = [];
  state.values.push(Math.random().toString(36).substring(2, 15));
});

export default recipe(inputSchema, outputSchema, ({ values }) => {
  /*derive(values, (values) => {
    console.log("values#", values.length);
  });*/
  return {
    [NAME]: "Simple Value",
    [UI]: (
      <div>
        <button onclick={adder({ values })}>Add Value</button>
        <div>
          {values.map((value, index) => (
            <div>
              {index}: {value}
            </div>
          ))}
        </div>
      </div>
    ),
    updater: updater({ values }),
    values,
  };
});
