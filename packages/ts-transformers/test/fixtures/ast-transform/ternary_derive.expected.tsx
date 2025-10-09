import * as __ctHelpers from "commontools";
import { Cell, Default, derive, h, handler, NAME, Opaque, OpaqueRef, recipe, str, UI, } from "commontools";
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
__ctHelpers.NAME; // <internals>
