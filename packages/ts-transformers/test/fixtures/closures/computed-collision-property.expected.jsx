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
}, { multiplier: number; value: number; }>(({ multiplier }) => ({
    multiplier: multiplier.get(),
    value: multiplier.get() * 3,
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
        multiplier: {
            type: "number"
        },
        value: {
            type: "number"
        }
    },
    required: ["multiplier", "value"]
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
__cfBindVerifiedBinding(__cfLift_1, {
    sourceFile: "/test.tsx",
    position: { line: 14, col: 26 },
    bindingName: "result"
});
// FIXTURE: computed-collision-property
// Verifies: a captured cell named the same as a returned object property does not rename the property
//   computed(() => ({ multiplier: multiplier.get(), value: ... })) → lift(...)({ multiplier })
// Context: returned object literal `{ multiplier: ... }` property name stays unchanged while the
//   captured variable reference resolves to the capture binding
export default __cfBindVerifiedBinding(pattern(() => {
    const multiplier = new Writable(2, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("multiplier", true);
    // The callback returns an object with a property named 'multiplier'.
    // Only the variable reference should resolve to the capture, NOT the property name.
    const result = __cfLift_1({ multiplier: multiplier }).for("result", true);
    return result;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        multiplier: {
            type: "number"
        },
        value: {
            type: "number"
        }
    },
    required: ["multiplier", "value"]
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
