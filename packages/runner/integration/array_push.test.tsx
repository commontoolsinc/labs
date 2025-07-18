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

const ARRAY_LENGTH=100;

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
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          value: { type: "number" },
        },
      },
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
    const my_array = cell<{ name: string; value: number }[]>([]);

    // BATCH VERSION - causes "Path must not be empty" errors
    const pushHandler = handler({}, {
      type: "object",
      properties: {
        array: {
          type: "array",
          asCell: true,
          items: {
            type: "object",
            properties: { name: { type: "string" }, value: { type: "number" } },
          },
        },
      },
      required: ["array"],
    }, (_, { array }) => {
      console.log("[pushHandler] Pushing all items at once");
      const itemsToAdd = Array.from({ length: ARRAY_LENGTH }, (_, i) => ({
        name: `Item ${i}`,
        value: i,
      }));
      console.log("[pushHandler] Before push - array:", array);
      console.log("[pushHandler] Items to add:", itemsToAdd);
      array.push(...itemsToAdd);
      //      array.push(itemsToAdd[0]);
      console.log("[pushHandler] After push - array.get():", array.get());
    });

    // const pushHandler = handler(
    //   ({ value }: { value: number }, { array }: { array: { name: string; value: number }[] }) => {
    //     console.log("Pushing value:", value);
    //     array.push({ name: `Item ${value}`, value: value });
    //   },
    // );

    // Return the recipe
    return {
      [NAME]: "array push test",
      [UI]: (
        <div>
          <h3>Array Push Test</h3>
          <p>Array length: {derive(my_array, (arr) => arr.length)}</p>
          <p>
            <ul>
              Current values: {my_array.map((e) => <li>{e.name}</li>)}
            </ul>
          </p>
        </div>
      ),
      my_array,
      pushHandler: pushHandler({ array: my_array }),
    };
  },
);
