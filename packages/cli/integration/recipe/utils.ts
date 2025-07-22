import { handler, schema } from "commontools";

// Different way to define the same schema, using 'schema' helper function,
// let's as leave off `as const satisfies JSONSchema`.
export const model = schema({
  type: "object",
  properties: {
    value: { type: "number", default: 0, asCell: true },
    // For integreation test:
    stringField: { type: "string" },
    numberField: { type: "number" },
    booleanField: { type: "boolean" },
    arrayField: { type: "array", items: { type: "number" } },
    userData: {
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: { name: { type: "string" }, age: { type: "number" } },
        },
      },
    },
    listField: { type: "array", items: { type: "string" } },
  },
  default: { value: 0 },
});

export const increment = handler({}, model, (_, state) => {
  state.value.set(state.value.get() + 1);
});

export const decrement = handler({}, model, (_, state) => {
  state.value.set(state.value.get() - 1);
});
