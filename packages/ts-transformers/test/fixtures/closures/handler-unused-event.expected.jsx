import * as __ctHelpers from "commontools";
import { Cell, pattern, UI } from "commontools";
interface State {
    counter: Cell<number>;
}
// FIXTURE: handler-unused-event
// Verifies: inline handler with an unused event param (_) still generates an event schema placeholder
//   onClick={(_) => state.counter.set(...)) → handler(event schema with detail, capture schema, (_, { state }) => ...)({ state })
// Context: Event param is named _ (unused); transformer still emits event schema with { detail: true }
export default pattern((state) => {
    return {
        [UI]: (<button type="button" onClick={__ctHelpers.handler({
            type: "object",
            properties: {
                detail: {
                    type: "unknown"
                }
            },
            required: ["detail"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        counter: {
                            type: "number",
                            asCell: true
                        }
                    },
                    required: ["counter"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, (_, { state }) => state.counter.set(state.counter.get() + 1))({
            state: {
                counter: state.key("counter")
            }
        })}>
        Increment (ignore event)
      </button>),
    };
}, {
    type: "object",
    properties: {
        counter: {
            type: "number",
            asCell: true
        }
    },
    required: ["counter"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "#/$defs/JSXElement"
        }
    },
    required: ["$UI"],
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
