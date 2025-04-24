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
    newValues: { type: "array", items: { type: "string" } },
  },
  title: "Update Values",
  description: "Append `newValues` to the list.",
  example: { newValues: ["foo", "bar"] },
  default: { newValues: [] },
} as const satisfies JSONSchema;

// Different way to define the same schema, using 'schema' helper function,
// let's as leave off `as const satisfies JSONSchema` and fields are writable.
const inputSchema = schema({
  type: "object",
  properties: {
    values: { type: "array", items: { type: "string" }, asCell: true },
  },
  default: { values: [] },
});

const outputSchema = {
  type: "object",
  properties: {
    values: { type: "array", items: { type: "string" } },
    updater: {
      asStream: true,
      ...updaterSchema,
    },
  },
} as const satisfies JSONSchema;

const updater = handler(
  updaterSchema,
  inputSchema,
  (event, state) => {
    console.log("updating values", event);
    event.newValues.forEach((value) => {
      console.log("adding value", value);
      state.values.push(value);
    });
  },
);

const adder = handler({}, inputSchema, (_, state) => {
  console.log("adding a value");
  state.values.push(Math.random().toString(36).substring(2, 15));
});

export default recipe(inputSchema, outputSchema, ({ values }) => {
  derive(values, (values) => {
    console.log("values#", values?.length);
  });
  return {
    [NAME]: str`Simple Value: ${
      derive(values, (values) => values?.length || 0)
    }`,
    [UI]: (
      <div>
        <button type="button" onClick={adder({ values })}>Add Value</button>
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
