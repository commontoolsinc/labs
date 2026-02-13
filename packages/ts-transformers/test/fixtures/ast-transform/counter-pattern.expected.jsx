import * as __ctHelpers from "commontools";
import { Cell, Default, handler, NAME, pattern, str, UI } from "commontools";
interface CounterState {
    value: Cell<number>;
}
interface PatternState {
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
const decrement = handler(false as const satisfies __ctHelpers.JSONSchema, {
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
export default pattern({
    type: "object",
    properties: {
        value: {
            type: "number",
            "default": 0
        }
    },
    required: ["value"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        $NAME: {
            type: "string",
            asOpaque: true
        },
        $UI: {
            $ref: "#/$defs/JSXElement"
        },
        value: {
            type: "number",
            asOpaque: true
        }
    },
    required: ["$NAME", "$UI", "value"],
    $defs: {
        JSXElement: {
            anyOf: [{
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }, {
                    type: "object",
                    properties: {}
                }, {
                    $ref: "#/$defs/UIRenderable",
                    asOpaque: true
                }]
        },
        UIRenderable: {
            type: "object",
            properties: {
                $UI: {
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }
            },
            required: ["$UI"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    return {
        [NAME]: str `Simple counter: ${state.value}`,
        [UI]: (<div>
        <ct-button onClick={decrement(state)}>-</ct-button>
        <ul>
          <li>next number: {__ctHelpers.ifElse({
            type: "number",
            asOpaque: true
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{
                    type: "number"
                }, {
                    type: "string"
                }]
        } as const satisfies __ctHelpers.JSONSchema, state.value, __ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        value: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["value"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
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
