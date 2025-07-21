/// <cts-enable />
import { Cell, derive, h, handler, NAME, recipe, str, UI, toSchema, JSONSchema } from "commontools";
const adder = handler({
    type: "object",
    additionalProperties: true
} as const satisfies JSONSchema, {
    type: "object",
    properties: {
        values: {
            type: "array",
            items: {
                type: "string"
            },
            asCell: true
        }
    },
    required: ["values"]
} as const satisfies JSONSchema, (_, state: {
    values: Cell<string[]>;
}) => {
    state.values.push(Math.random().toString(36).substring(2, 15));
});
export default recipe({
    type: "object",
    properties: {
        values: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["values"]
} as const satisfies JSONSchema, ({ values }) => {
    derive(values, (values) => {
        console.log("values#", values?.length);
    });
    return {
        [NAME]: str `Simple Value: ${values.length || 0}`,
        [UI]: (<div>
          <button type="button" onClick={adder({ values })}>Add Value</button>
          <div>
            {values.map((value, index) => (<div>
                {index}: {value}
              </div>))}
          </div>
        </div>),
        values,
    };
});