import * as __ctHelpers from "commontools";
import { Default, h, NAME, recipe, UI } from "commontools";
interface RecipeState {
    count: Default<number, 0>;
    label: Default<string, "">;
}
export default recipe({
    type: "object",
    properties: {
        count: {
            type: "number",
            default: 0
        },
        label: {
            type: "string",
            default: ""
        }
    },
    required: ["count", "label"]
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    return {
        [NAME]: state.label,
        [UI]: (<section>
        {__ctHelpers.ifElse(__ctHelpers.derive({ state, state_count: state.count }, ({ state: state, state_count: _v2 }) => state && _v2 > 0), <p>Positive</p>, <p>Non-positive</p>)}
      </section>),
    };
});
__ctHelpers.NAME; // <internals>
