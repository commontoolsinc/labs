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
    numbers: __cfHelpers.ReadonlyCell<number[]>;
    multiplier: __cfHelpers.ReadonlyCell<number>;
}, number[]>(({ numbers, multiplier }) => numbers.get().map((n) => n * multiplier.get()), {
    type: "object",
    properties: {
        numbers: {
            type: "array",
            items: {
                type: "number"
            },
            asCell: ["readonly"]
        },
        multiplier: {
            type: "number",
            asCell: ["readonly"]
        }
    },
    required: ["numbers", "multiplier"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "number"
    }
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
__cfBindVerifiedBinding(__cfLift_1, {
    sourceFile: "/test.tsx",
    position: { line: 14, col: 26 },
    bindingName: "result"
});
// FIXTURE: computed-nested-callback
// Verifies: capture extraction works with a nested .map() over a captured cell's array value
//   computed(() => numbers.get().map(n => n * multiplier.get())) → lift(...)({ numbers, multiplier })
//   inner numbers.get().map(fn) runs on a plain array → NOT rewritten to mapWithPattern
// Context: both `numbers` and `multiplier` are captured cells; the inner map reads `multiplier`
export default __cfBindVerifiedBinding(pattern(() => {
    const numbers = new Writable([1, 2, 3], {
        type: "array",
        items: {
            type: "number"
        }
    } as const satisfies __cfHelpers.JSONSchema).for("numbers", true);
    const multiplier = new Writable(2, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("multiplier", true);
    // Nested callback - the inner array map runs on the unwrapped plain array
    const result = __cfLift_1({
        numbers: numbers,
        multiplier: multiplier
    }).for("result", true);
    return result;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "number"
    }
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 9, col: 23 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1
});
