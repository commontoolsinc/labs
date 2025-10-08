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
        {typedValues.map_with_pattern(recipe({
                type: "object",
                properties: {
                    elem: {
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
                required: ["elem", "params"]
            } as const satisfies JSONSchema, ({ elem, params: { multiplier } }) => (<span>{elem * multiplier}</span>)), { multiplier: state.multiplier })}
      </div>),
    };
});
