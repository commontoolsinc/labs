import * as __ctHelpers from "commontools";
import { Cell, Default, handler, NAME, pattern, str, UI } from "commontools";
interface CounterState {
    value: Cell<number>;
}
interface PatternState {
    value: Default<number, 0>;
}
const increment = handler({
    type: "unknown"
} as const satisfies __ctHelpers.JSONSchema, {
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
// FIXTURE: counter-pattern
// Verifies: full pattern with handlers, ternary, str template, and schema generation
//   handler<unknown, CounterState>(fn) → handler(true, stateSchema, fn)
//   handler((_, state: {...}) => ...)  → handler(false, stateSchema, fn)
//   pattern<PatternState>(fn)          → pattern(fn, inputSchema, outputSchema)
//   state.value ? a : b (in JSX)      → __ctHelpers.ifElse(...schemas, state.key("value"), derive(...), "unknown")
//   state.value                        → state.key("value")
// Context: Combines handler schema injection, pattern schema generation, ternary-to-ifElse, and str template transforms
export default pattern((state) => {
    return {
        [NAME]: str `Simple counter: ${state.key("value")}`,
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
            type: ["number", "string"]
        } as const satisfies __ctHelpers.JSONSchema, state.key("value"), __ctHelpers.derive({
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
                value: state.key("value")
            } }, ({ state }) => state.value + 1), "unknown")}</li>
        </ul>
        <ct-button onClick={increment({ value: state.key("value") })}>+</ct-button>
      </div>),
        value: state.key("value"),
    };
}, {
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
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
