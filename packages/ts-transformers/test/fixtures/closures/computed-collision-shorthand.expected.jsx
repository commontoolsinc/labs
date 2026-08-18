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
import { Writable, computed, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const __cfLift_1 = __cfHelpers.lift<{
    multiplier: __cfHelpers.ReadonlyCell<number>;
}, { value: number; data: { multiplier: __cfHelpers.Cell<number>; }; }>(({ multiplier }) => ({
    value: multiplier.get() * 3,
    data: { multiplier: multiplier },
}), {
    type: "object",
    properties: {
        multiplier: {
            type: "number",
            asCell: ["readonly"]
        }
    },
    required: ["multiplier"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        value: {
            type: "number"
        },
        data: {
            type: "object",
            properties: {
                multiplier: {
                    type: "number",
                    asCell: ["cell"]
                }
            },
            required: ["multiplier"]
        }
    },
    required: ["value", "data"]
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
__cfBindVerifiedBinding(__cfLift_1, {
    sourceFile: "/test.tsx",
    position: { line: 12, col: 26 },
    bindingName: "result"
});
// FIXTURE: computed-collision-shorthand
// Verifies: a shorthand property `{ multiplier }` over a captured cell expands correctly
//   computed(() => ({ value, data: { multiplier } })) → lift(...)({ multiplier })
// Context: shorthand must keep the property name while binding to the captured value
export default __cfBindVerifiedBinding(pattern(() => {
    const multiplier = new Writable(2, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("multiplier", true);
    // The callback uses shorthand property { multiplier } over the captured cell.
    const result = __cfLift_1({ multiplier: multiplier }).for("result", true);
    return result;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        value: {
            type: "number"
        },
        data: {
            type: "object",
            properties: {
                multiplier: {
                    type: "number",
                    asCell: ["cell"]
                }
            },
            required: ["multiplier"]
        }
    },
    required: ["value", "data"]
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 8, col: 23 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1
});
