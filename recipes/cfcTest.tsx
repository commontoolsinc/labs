import { h } from "@commontools/html";
import {
  derive,
  handler,
  JSONSchema,
  NAME,
  recipe,
  str,
  UI,
} from "@commontools/builder";

const UpdaterSchema = {
  type: "object",
  properties: {
    newValues: {
      type: "array",
      items: {
        type: "string",
        ifc: { classification: ["confidential"] },
      },
    },
  },
  title: "Update Values",
  description: "Append `newValues` to the list.",
  example: { newValues: ["foo", "bar"] },
  default: { newValues: [] },
} as const satisfies JSONSchema;

const InputSchema = {
  type: "object",
  properties: {
    values: {
      type: "array",
      items: { type: "string", ifc: { classification: ["confidential"] } },
      asCell: true,
    },
  },
  default: {
    values: ["string"],
  },
} as const satisfies JSONSchema;

const OutputSchema = {
  type: "object",
  properties: {
    values: { type: "array", items: { type: "string" } },
    updater: {
      asStream: true,
      ...UpdaterSchema,
    },
  },
} as const satisfies JSONSchema;

const updater = handler(
  UpdaterSchema,
  InputSchema,
  (event, state) => {
    console.log("updating values", event);
    event.newValues.forEach((value) => {
      console.log("adding value", value);
      state.values.push(value);
    });
  },
);

const adder = handler({}, InputSchema, (_, state) => {
  console.log("adding a value");
  state.values.push(Math.random().toString(36).substring(2, 15));
});

export default recipe(InputSchema, OutputSchema, ({ values }) => {
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
