/// <cts-enable />
import { Cell, h, handler, NAME, recipe, str, UI, derive, toSchema, JSONSchema } from "commontools";
interface CounterState {
    value: Cell<number>;
}
interface RecipeState {
    value: number;
}
const increment = handler({
    type: "any"
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
    type: "any"
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
export default recipe<RecipeState>("Counter", (state) => {
    return {
        [NAME]: str `Simple counter: ${state.value}`,
        [UI]: (<div>
        <ct-button onClick={decrement(state)}>-</ct-button>
        <ul>
          <li>next number: {commontools_1.derive(state.value, _v1 => _v1 + 1)}</li>
        </ul>
        <ct-button onClick={increment({ value: state.value })}>+</ct-button>
      </div>),
        value: state.value,
    };
});
