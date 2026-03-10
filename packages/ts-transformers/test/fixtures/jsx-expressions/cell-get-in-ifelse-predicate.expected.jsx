import * as __ctHelpers from "commontools";
import { Cell, ifElse, pattern, UI } from "commontools";
// Reproduction of bug: .get() called on Cell inside ifElse predicate
// The transformer wraps predicates in derive(), which unwraps Cells,
// but fails to remove the .get() calls
// FIXTURE: cell-get-in-ifelse-predicate
// Verifies: .get() calls on Cell refs inside ifElse predicates are preserved within derive()
//   showHistory && messageCount !== dismissedIndex.get() → derive(..., ({...}) => showHistory && messageCount !== dismissedIndex.get())
// Context: Bug repro -- predicate wrapped in derive() which unwraps Cells, but .get() must remain
export default pattern((__ct_pattern_input) => {
    const showHistory = __ct_pattern_input.key("showHistory");
    const messageCount = __ct_pattern_input.key("messageCount");
    const dismissedIndex = __ct_pattern_input.key("dismissedIndex");
    return {
        [UI]: (<div>
        {ifElse({
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __ctHelpers.JSONSchema, {
            $ref: "#/$defs/UIRenderable",
            $defs: {
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
        } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
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
                    asCell: true
                }
            },
            required: ["showHistory", "messageCount", "dismissedIndex"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, {
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
            asCell: true
        }
    },
    required: ["showHistory", "messageCount", "dismissedIndex"]
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
                    $ref: "#/$defs/UIRenderable"
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
