function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Cell, ifElse, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// Reproduction of bug: .get() called on Cell inside ifElse predicate
// The transformer wraps predicates in derive(), which unwraps Cells,
// but fails to remove the .get() calls
// FIXTURE: cell-get-in-ifelse-predicate
// Verifies: .get() calls on Cell refs inside ifElse predicates are preserved within derive()
//   showHistory && messageCount !== dismissedIndex.get() → derive(..., ({...}) => showHistory && messageCount !== dismissedIndex.get())
// Context: Bug repro -- predicate wrapped in derive() which unwraps Cells, but .get() must remain
export default pattern((__cf_pattern_input) => {
    const showHistory = __cf_pattern_input.key("showHistory");
    const messageCount = __cf_pattern_input.key("messageCount");
    const dismissedIndex = __cf_pattern_input.key("dismissedIndex");
    return {
        [UI]: (<div>
        {ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, {} as const satisfies __cfHelpers.JSONSchema, __cfHelpers.derive({
            type: "object",
            properties: {
                showHistory: {
                    type: "boolean"
                },
                messageCount: {
                    type: "number"
                },
                dismissedIndex: {
                    type: "number",
                    asCell: ["cell"]
                }
            },
            required: ["showHistory", "messageCount", "dismissedIndex"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            showHistory: showHistory,
            messageCount: messageCount,
            dismissedIndex: dismissedIndex
        }, ({ showHistory, messageCount, dismissedIndex }) => showHistory && messageCount !== dismissedIndex.get()), <div>Show notification</div>, <div>Hide notification</div>)}
      </div>),
    };
}, {
    type: "object",
    properties: {
        showHistory: {
            type: "boolean"
        },
        messageCount: {
            type: "number"
        },
        dismissedIndex: {
            type: "number",
            asCell: ["cell"]
        }
    },
    required: ["showHistory", "messageCount", "dismissedIndex"]
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
__cfHardenFn(h);
