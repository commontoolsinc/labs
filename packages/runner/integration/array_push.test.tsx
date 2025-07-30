import {
  cell,
  derive,
  h,
  handler,
  ID,
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
    my_numbers_array: {
      type: "array",
      items: { type: "number" },
      default: [],
      asCell: true,
    },
    my_objects_array: {
      type: "array",
      items: { type: "object", properties: { count: { type: "number" } } },
      default: [],
      asCell: true,
    },
    pushNumbersHandler: { asStream: true, type: "object", properties: {} },
    pushObjectsHandler: { asStream: true, type: "object", properties: {} },
  },
  required: [
    "my_numbers_array",
    "my_objects_array",
    "pushNumbersHandler",
    "pushObjectsHandler",
  ],
} as const satisfies JSONSchema;

export default recipe(
  InputSchema,
  OutputSchema,
  () => {
    const my_numbers_array = cell<number[]>([]);
    const my_objects_array = cell<{ count: number }[]>([]);

    const pushNumbersHandler = handler({
      type: "object",
      properties: { value: { type: "number" } },
      required: ["value"],
    }, {
      type: "object",
      properties: {
        array: { type: "array", items: { type: "number" }, asCell: true },
      },
      required: ["array"],
    }, ({ value }, { array }) => {
      console.log("Pushing value:", value);
      array.push(value);
    });

    const pushObjectsHandler = handler({
      type: "object",
      properties: {
        value: { type: "object", properties: { count: { type: "number" } } },
      },
      required: ["value"],
    }, {
      type: "object",
      properties: {
        array: {
          type: "array",
          items: { type: "object", properties: { count: { type: "number" } } },
          asCell: true,
        },
      },
      required: ["array"],
    }, ({ value }, { array }) => {
      console.log("Pushing object:", { count: value.count });
      array.push({ count: value.count, [ID]: value.count });
    });

    // Return the recipe
    return {
      [NAME]: "array push test",
      [UI]: (
        <div>
          <h3>Array Push Test</h3>
          <p>Array length: {derive(my_numbers_array, (arr) => arr.length)}</p>
          <p>
            <ul>
              Current values:{" "}
              {my_numbers_array.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          </p>
          <p>
            <ul>
              Current values:{" "}
              {my_objects_array.map((e, i) => <li key={i}>{e.count}</li>)}
            </ul>
          </p>
        </div>
      ),
      my_numbers_array,
      my_objects_array,
      pushNumbersHandler: pushNumbersHandler({ array: my_numbers_array }),
      pushObjectsHandler: pushObjectsHandler({ array: my_objects_array }),
    };
  },
);
