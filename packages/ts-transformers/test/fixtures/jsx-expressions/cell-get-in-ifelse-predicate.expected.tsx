import * as __ctHelpers from "commontools";
import { Cell, ifElse, recipe, UI } from "commontools";
// Reproduction of bug: .get() called on Cell inside ifElse predicate
// The transformer wraps predicates in derive(), which unwraps Cells,
// but fails to remove the .get() calls
export default recipe({
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
} as const satisfies __ctHelpers.JSONSchema, ({ showHistory, messageCount, dismissedIndex }) => {
    return {
        [UI]: (<div>
        {ifElse(__ctHelpers.derive({
            type: "object",
            properties: {
                showHistory: {
                    anyOf: [{
                            type: "boolean",
                            enum: [false],
                            asOpaque: true
                        }, {
                            type: "boolean",
                            enum: [true],
                            asOpaque: true
                        }]
                },
                messageCount: {
                    type: "number",
                    asOpaque: true
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
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
