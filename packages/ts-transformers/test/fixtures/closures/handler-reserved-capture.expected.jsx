import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
interface State {
    label: string;
}
export default pattern((state) => {
    const __ct_handler_event = state.label;
    return {
        [UI]: (<button type="button" onClick={__ctHelpers.handler(false as const satisfies __ctHelpers.JSONSchema, {
            type: "object",
            properties: {
                __ct_handler_event: {
                    type: "string",
                    asOpaque: true
                }
            },
            required: ["__ct_handler_event"]
        } as const satisfies __ctHelpers.JSONSchema, (__ct_handler_event_1, { __ct_handler_event }) => __ct_handler_event)({
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
