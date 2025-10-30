import * as __ctHelpers from "commontools";
import { Cell, Default, handler, NAME, recipe, str, UI } from "commontools";
interface CounterState {
    value: Cell<number>;
}
interface RecipeState {
    value: Default<number, 0>;
}
const increment = handler(true as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        value: {
            type: "number",
            asCell: true
        }
    },
    required: ["value"]
} as const satisfies __ctHelpers.JSONSchema, (_e, state) => {
    state.value.set(state.value.get() + 1);
});
const decrement = handler(true as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        value: {
            type: "number",
            asCell: true
        }
    },
    required: ["value"]
} as const satisfies __ctHelpers.JSONSchema, (_, state: {
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
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    return {
        [NAME]: str `Simple counter: ${state.value}`,
        [UI]: (<div>
        <ct-button onClick={decrement(state)}>-</ct-button>
        <ul>
          <li>next number: {__ctHelpers.ifElse(state.value, __ctHelpers.derive({ state: {
                value: state.value
            } }, ({ state }) => state.value + 1), "unknown")}</li>
        </ul>
        <ct-button onClick={increment({ value: state.value })}>+</ct-button>
      </div>),
        value: state.value,
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
