import * as __cfHelpers from "commonfabric";
import { Cell, pattern, UI } from "commonfabric";
interface State {
    counter: Cell<number>;
}
// FIXTURE: handler-no-captures
// Verifies: inline handler with no captured outer variables still gets wrapped with empty captures
//   onClick={() => console.log("hi")) → handler(false, { properties: {} }, (_, __ct_handler_params) => ...)({})
// Context: No closed-over state; capture object is empty
export default pattern((_state) => {
    return {
        [UI]: (<button type="button" onClick={__cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
            type: "object",
            properties: {}
        } as const satisfies __cfHelpers.JSONSchema, (__ct_handler_event, __ct_handler_params) => console.log("hi"))({})}>
        Log
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
