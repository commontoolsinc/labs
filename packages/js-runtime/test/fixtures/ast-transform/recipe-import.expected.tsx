/// <cts-enable />
// Test case: Recipe that imports and uses another recipe
// This tests that transformed code works when recipes are imported from other modules
import { recipe, UI, h, navigateTo, handler, JSONSchema } from "commontools";
import Counter from "./counter-recipe.input.tsx";
const createCounter = handler({
    type: "object",
    additionalProperties: true
} as const satisfies JSONSchema, {
    type: "object",
    additionalProperties: true
} as const satisfies JSONSchema, () => {
    return navigateTo(Counter({ value: 42 }));
});
export default recipe({ type: "object", properties: {}, required: [] }, () => {
    // This calls the imported Counter recipe
    // The Counter recipe contains transformed code (derive calls)
    // which reference commontools_1 that won't be in scope here
    const counterInstance = Counter({ value: 42 });
    return {
        [UI]: (<ct-button onClick={createCounter}>
            Create Counter
          </ct-button>)
    };
});

/// <cts-enable />
import { Cell, Default, h, handler, NAME, recipe, str, UI, ifElse, derive, JSONSchema } from "commontools";
interface CounterState {
    value: Cell<number>;
}
interface RecipeState {
    value: Default<number, 0>;
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
} as const satisfies JSONSchema, (e, state) => {
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
} as const satisfies JSONSchema, (_, state: {
    value: Cell<number>;
}) => {
    state.value.set(state.value.get() - 1);
});
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
        [NAME]: str `Simple counter: ${state.value}`,
        [UI]: (<div>
        <ct-button onClick={decrement(state)}>-</ct-button>
        <ul>
          <li>next number: {(globalThis.__CT_COMMONTOOLS).ifElse(state.value, (globalThis.__CT_COMMONTOOLS).derive(state.value, _v1 => _v1 + 1), "unknown")}</li>
        </ul>
        <ct-button onClick={increment({ value: state.value })}>+</ct-button>
      </div>),
        value: state.value,
    };
});

