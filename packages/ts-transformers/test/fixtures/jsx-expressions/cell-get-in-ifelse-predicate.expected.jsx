function __cfBindVerifiedBinding(value: any, metadata: any) {
    if (value && (typeof value === "object" || typeof value === "function") && Object.isExtensible(value)) {
        Object.defineProperty(value, "__cfVerifiedBindingIdentity", {
            value: metadata,
            configurable: true
        });
    }
    if (value && (typeof value === "object" || typeof value === "function") && typeof value.implementation === "function") {
        var implementation = value.implementation;
        if (implementation && (typeof implementation === "object" || typeof implementation === "function") && Object.isExtensible(implementation)) {
            Object.defineProperty(implementation, "__cfVerifiedBindingIdentity", {
                value: metadata,
                configurable: true
            });
        }
    }
    return value;
}
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
const __cfLift_1 = __cfHelpers.lift<{
    showHistory: boolean;
    messageCount: number;
    dismissedIndex: __cfHelpers.ReadonlyCell<number>;
}, boolean>(({ showHistory, messageCount, dismissedIndex }) => showHistory && messageCount !== dismissedIndex.get(), {
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
            asCell: ["readonly"]
        }
    },
    required: ["showHistory", "messageCount", "dismissedIndex"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
__cfBindVerifiedBinding(__cfLift_1, {
    sourceFile: "/test.tsx",
    position: { line: 20, col: 10 }
});
// Reproduction of bug: .get() called on Cell inside ifElse predicate
// The transformer wraps predicates in a lift-applied computation, which unwraps Cells,
// but fails to remove the .get() calls
// FIXTURE: cell-get-in-ifelse-predicate
// Verifies: .get() calls on Cell refs inside ifElse predicates are preserved within the lift-applied computation
//   showHistory && messageCount !== dismissedIndex.get() → lift(({...}) => showHistory && messageCount !== dismissedIndex.get())(...)
// Context: Bug repro -- predicate wrapped in a lift-applied computation which unwraps Cells, but .get() must remain
export default __cfBindVerifiedBinding(pattern((__cf_pattern_input) => {
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
        } as const satisfies __cfHelpers.JSONSchema, {} as const satisfies __cfHelpers.JSONSchema, __cfLift_1({
            showHistory: showHistory,
            messageCount: messageCount,
            dismissedIndex: dismissedIndex
        }), <div>Show notification</div>, <div>Hide notification</div>)}
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
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 15, col: 3 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1
});
