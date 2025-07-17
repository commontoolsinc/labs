/// <cts-enable />
import { recipe, UI, NAME, str, handler, h, Cell, ifElse, derive, toSchema, JSONSchema } from "commontools";
interface RecipeState {
    value: number;
}
const increment = handler({
    type: "object",
    additionalProperties: true
} as const satisfies JSONSchema, {
    type: "object",
    properties: {
        value: {
            type: "number",
            asCell: true
        }
    },
    required: ["value"]
} as const satisfies JSONSchema, (e, state: {
    value: Cell<number>;
}) => {
    state.value.set(state.value.get() + 1);
});
const decrement = handler({
    type: "object",
    additionalProperties: true
} as const satisfies JSONSchema, {
    type: "object",
    properties: {
        value: {
            type: "number",
            asCell: true
        }
    },
    required: ["value"]
} as const satisfies JSONSchema, (e, state: {
    value: Cell<number>;
}) => {
    state.value.set(state.value.get() - 1);
});
export default recipe({
    type: "object",
    properties: {
        value: {
            type: "number"
        }
    },
    required: ["value"]
} as const satisfies JSONSchema, (state) => {
    // These should NOT be transformed (statement context)
    const next = state.value + 1;
    const previous = state.value - 1;
    const doubled = state.value * 2;
    const isHigh = state.value > 10;
    // This should NOT be transformed (statement context)
    if (state.value > 100) {
        console.log("Too high!");
    }
    return {
        // This template literal SHOULD be transformed (builder function context)
        [NAME]: str `Simple counter: ${state.value}`,
        [UI]: (<div>
        <ct-button onClick={decrement(state)}>-</ct-button>
        <p>
          {/* These SHOULD be transformed (JSX expression context) */}
          Current: {state.value}
          <br />
          Next number: {commontools_1.derive(state.value, _v1 => _v1 + 1)}
          <br />
          Previous: {commontools_1.derive(state.value, _v1 => _v1 - 1)}
          <br />
          Doubled: {commontools_1.derive(state.value, _v1 => _v1 * 2)}
          <br />
          Status: {commontools_1.ifElse(state.value > 10, "High", "Low")}
        </p>
        <ct-button onClick={increment({ value: state.value })}>+</ct-button>
      </div>),
        // Direct property access - no transformation needed
        value: state.value,
        // These should NOT be transformed (object literal in statement context)
        metadata: {
            next: next,
            previous: previous,
            doubled: doubled
        }
    };
});