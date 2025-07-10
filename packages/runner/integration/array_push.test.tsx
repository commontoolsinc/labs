import {
  cell,
  handler,
  UI,
  NAME,
  JSONSchema,
  recipe,
  h,
  derive,
} from "commontools";

// dummy input schema
const InputSchema = {
  type: "object",
  properties: {},
} as const satisfies JSONSchema;

// define output schema
const OutputSchema = {
  type: "object",
  properties: {
    my_array: {
      type: "array",
      items: { type: "number" },
      default: [],
      asCell: true,
    },
    pushHandler: { asStream: true, type: "object", properties: {} },
  },
  required: ["my_array"],
} as const satisfies JSONSchema;

export default recipe(
  InputSchema,
  OutputSchema,
  () => {
    const my_array = cell<number[]>([]);
    
    const pushHandler = handler(
      ({ value }: { value: number }, { array }: { array: number[] }) => {
        array.push(value);
      }
    );
    
    // Return the recipe
    return {
      [NAME]: "array push test",
      [UI]: (
        <div>
          <h3>Array Push Test</h3>
          <p>Array length: {derive(my_array, arr => arr.length)}</p>
          <p>Current values: {derive(my_array, arr => JSON.stringify(arr))}</p>
        </div>
      ),
      my_array,
      pushHandler: pushHandler({ array: my_array }),
    };
  },
);

