function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
/**
 * computed() result property access in derive captures should use
 * .key("length"). The computed() return is an OpaqueRef, so
 * rewritePatternBody correctly rewrites summary.length to
 * summary.key("length").
 */
import { computed, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface State {
    items: string[];
}
// FIXTURE: computed-result-property-in-return
// Verifies: .length on a computed() string result is captured via .key("length") in a subsequent derive
//   computed(() => summary.length) → derive(..., { summary: { length: summary.key("length") } }, ({ summary }) => summary.length)
// Context: The first computed() returns a string OpaqueRef (from .join()).
//   When the second computed() accesses summary.length, the capture is rewritten
//   to summary.key("length") because summary is an OpaqueRef, not a plain value.
export default pattern((state) => {
    const summary = __cfHelpers.derive({
        type: "object",
        properties: {
            state: {
                type: "object",
                properties: {
                    items: {
                        type: "array",
                        items: {
                            type: "string"
                        }
                    }
                },
                required: ["items"]
            }
        },
        required: ["state"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, { state: {
            items: state.key("items")
        } }, ({ state }) => state.items.join(", ")).for("summary", true);
    return {
        summary,
        charCount: __cfHelpers.derive({
            type: "object",
            properties: {
                summary: {
                    type: "object",
                    properties: {
                        length: {
                            type: "number"
                        }
                    },
                    required: ["length"]
                }
            },
            required: ["summary"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { summary: {
                length: summary.key("length")
            } }, ({ summary }) => summary.length).for(["__patternResult", "charCount"], true)
    };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["items"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        summary: {
            type: "string"
        },
        charCount: {
            type: "number"
        }
    },
    required: ["summary", "charCount"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
