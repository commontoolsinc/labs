/// <cts-enable />
import { Cell, Default, derive, h, handler, NAME, Opaque, OpaqueRef, recipe, str, UI, ifElse, JSONSchema } from "commontools";
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
} as const satisfies JSONSchema, (state) => {
    return {
        [NAME]: "test ternary with derive",
        [UI]: (<div>
          {(globalThis.__CT_COMMONTOOLS).ifElse((globalThis.__CT_COMMONTOOLS).derive(state.value, _v1 => _v1 + 1), (globalThis.__CT_COMMONTOOLS).derive(state.value, _v1 => _v1 + 2), "undefined")}
      </div>),
    };
});

