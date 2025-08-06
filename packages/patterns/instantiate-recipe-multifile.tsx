import {
  Cell,
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

import Counter from "./counter.tsx";

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

const newPage = handler(
  { type: 'object', properties: { detail: { type: 'object', properties: { message: { type: 'string' } } } } },
  { type: 'object' },
  (e, _) => {
    const charm = Counter({ value: Math.round(Math.random()*10) });
    return navigateTo(charm);
  },
);

export default recipe(InputSchema, OutputSchema, ({ }) => {
  return {
    [NAME]: "Page Factory",
    [UI]: (
      <div>
        <ct-message-input
          name="Add"
          placeholder="New page"
          appearance="rounded"
          onct-send={newPage({ })}
        />
      </div>
    ),
  };
});
