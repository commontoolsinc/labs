/// <cts-enable />
import { Default, h, NAME, recipe, UI, ifElse, derive, JSONSchema } from "commontools";
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
} as const satisfies JSONSchema, (state) => {
    return {
        [NAME]: state.label,
        [UI]: (<section>
        {ifElse(derive({ state, state_count: state.count }, ({ state: state, state_count: _v2 }) => state && _v2 > 0), <p>Positive</p>, <p>Non-positive</p>)}
      </section>),
    };
});
