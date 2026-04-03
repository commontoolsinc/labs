import * as __cfHelpers from "commonfabric";
import { pattern, UI } from "commonfabric";
interface State {
    label: string;
}
// FIXTURE: handler-reserved-capture
// Verifies: captured variable named __ct_handler_event is renamed to avoid collision with the synthetic event param
//   onClick={() => __ct_handler_event) → handler(false, { __ct_handler_event: ... }, (__ct_handler_event_1, { __ct_handler_event }) => ...)
// Context: Edge case -- user variable collides with internal __ct_handler_event name; event param gets suffixed
export default pattern((state) => {
    const __ct_handler_event = state.key("label");
    return {
        [UI]: (<button type="button" onClick={__cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
            type: "object",
            properties: {
                __ct_handler_event: {
                    type: "string"
                }
            },
            required: ["__ct_handler_event"]
        } as const satisfies __cfHelpers.JSONSchema, (__ct_handler_event_1, { __ct_handler_event }) => __ct_handler_event)({
            __ct_handler_event: __ct_handler_event
        })}>
        Echo
      </button>),
    };
}, {
    type: "object",
    properties: {
        label: {
            type: "string"
        }
    },
    required: ["label"]
} as const satisfies __cfHelpers.JSONSchema, {
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
                    $ref: "#/$defs/UIRenderable"
                }, {
                    type: "object",
                    properties: {}
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
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
