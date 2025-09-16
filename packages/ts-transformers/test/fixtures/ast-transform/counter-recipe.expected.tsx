/// <cts-enable />
import { Cell, Default, h, handler, NAME, recipe, str, UI, ifElse, derive, JSONSchema } from "commontools";
interface CounterState {
    value: Cell<number>;
}
interface RecipeState {
    value: Default<number, 0>;
}
const increment = handler({} as const satisfies JSONSchema, {
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
const decrement = handler({} as const satisfies JSONSchema, {
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
          <li>next number: {commontools_1.ifElse(state.value, commontools_1.derive(state.value, _v1 => _v1 + 1), "unknown")}</li>
        </ul>
        <ct-button onClick={increment({ value: state.value })}>+</ct-button>
      </div>),
        value: state.value,
    };
});

