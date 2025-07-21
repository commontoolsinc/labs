import {
  cell,
  derive,
  h,
  handler,
  JSONSchema,
  NAME,
  recipe,
  UI,
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
        console.log("Pushing value:", value);
        array.push(value);
      },
      { proxy: true },
    );

    // Return the recipe
    return {
      [NAME]: "array push test",
      [UI]: (
        <div>
          <h3>Array Push Test</h3>
          <p>Array length: {derive(my_array, (arr) => arr.length)}</p>
          <p>
            <ul>
            Current values: {my_array.map((e) => (
              <li>{e}</li>
            ))}
            </ul>
          </p>
        </div>
      ),
      my_array,
      pushHandler: pushHandler({ array: my_array }),
    };
  },
);
