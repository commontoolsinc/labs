import * as __ctHelpers from "commontools";
import { Cell, cell, h, recipe, UI } from "commontools";
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
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    // Explicitly type as Cell to ensure closure transformation
    const typedValues: Cell<number[]> = cell(state.values);
    return {
        [UI]: (<div>
        {typedValues.mapWithPattern(__ctHelpers.recipe({
                $schema: "https://json-schema.org/draft/2020-12/schema",
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
            } as const satisfies __ctHelpers.JSONSchema, ({ element, params: { multiplier } }) => (<span>{element * multiplier}</span>)), { multiplier: state.multiplier })}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
