import * as __ctHelpers from "commontools";
import { Default, NAME, recipe, UI } from "commontools";
interface RecipeState {
    value: Default<number, 0>;
}
export default recipe({
    type: "object",
    properties: {
        value: {
            type: "number",
            default: 0
        }
    },
    required: ["value"]
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    return {
        [NAME]: "test ternary with derive",
        [UI]: (<div>
        {__ctHelpers.ifElse(__ctHelpers.derive(state.value, _v1 => _v1 + 1), __ctHelpers.derive(state.value, _v1 => _v1 + 2), "undefined")}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
