/// <cts-enable />
import { Cell, cell, h, recipe, UI, JSONSchema } from "commontools";
interface State {
    values: number[];
    multiplier: number;
}
export default recipe({
    type: "object",
    properties: {
        values: {
            type: "array",
            items: {
                type: "number"
            }
        },
        multiplier: {
            type: "number"
        }
    },
    required: ["values", "multiplier"]
} as const satisfies JSONSchema, (state) => {
    // Explicitly type as Cell to ensure closure transformation
    const typedValues: Cell<number[]> = cell(state.values);
    return {
        [UI]: (<div>
        {typedValues.mapWithPattern(recipe({
                type: "object",
                properties: {
                    element: {
                        type: "number"
                    },
                    params: {
                        type: "object",
                        properties: {
                            multiplier: {
                                type: "number",
                                asOpaque: true
                            }
                        },
                        required: ["multiplier"]
                    }
                },
                required: ["element", "params"]
            } as const satisfies JSONSchema, ({ element, params: { multiplier } }) => (<span>{element * multiplier}</span>)), { multiplier: state.multiplier })}
      </div>),
    };
});
