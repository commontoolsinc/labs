import * as __ctHelpers from "commontools";
import { Default, NAME, recipe, UI } from "commontools";
interface RecipeState {
    count: Default<number, 0>;
    label: Default<string, "">;
}
export default recipe({
    type: "object",
    properties: {
        count: {
            type: "number",
            "default": 0
        },
        label: {
            type: "string",
            "default": ""
        }
    },
    required: ["count", "label"]
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    return {
        [NAME]: state.label,
        [UI]: (<section>
        {__ctHelpers.ifElse(__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        count: {
                            type: "number",
                            "default": 0
                        },
                        label: {
                            type: "string",
                            "default": ""
                        }
                    },
                    required: ["count", "label"],
                    asOpaque: true
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, { state: state }, ({ state }) => state && state.count > 0), <p>Positive</p>, <p>Non-positive</p>)}
      </section>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
