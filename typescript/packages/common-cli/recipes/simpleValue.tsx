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

const updaterSchema = {
  type: "object",
  properties: {
    newValues: { type: "array", items: { type: "string" } },
  },
  required: ["newValues"],
} as const satisfies JSONSchema;

const inputSchema = {
  type: "object",
  properties: {
    values: { type: "array", items: { type: "string" }, asCell: true },
  },
  default: { values: [] },
  required: ["values"],
} as const satisfies JSONSchema;

const outputSchema = {
  type: "object",
  properties: {
    values: { type: "array", items: { type: "string" } },
    updater: {
      asCell: true, // TODO(seefeld): Should be asStream
      ...updaterSchema,
    },
  },
} as const satisfies JSONSchema;

const updater = handler(
  updaterSchema,
  inputSchema,
  (event, state) => {
    console.log("updating values", event);
    event?.newValues?.forEach((value) => {
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
    [NAME]: "Simple Value",
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
