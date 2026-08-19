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
import { computed, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const __cfLift_1 = __cfHelpers.lift<{
    items: number[] & {} & { [SELF]: Reactive<any>; };
}, number[]>(({ items }) => items.map((n) => n * 2), {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "number"
            }
        }
    },
    required: ["items"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "number"
    }
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
__cfBindVerifiedBinding(__cfLift_1, {
    sourceFile: "/test.tsx",
    position: { line: 13, col: 27 },
    bindingName: "doubled"
});
// FIXTURE: pattern-computed-reactive-map
// Verifies: .map() on a Reactive inside computed() is NOT transformed to mapWithPattern
//   computed(() => items.map((n) => n * 2)) → lift(({ items }) => items.map((n) => n * 2))({ items })
// Context: Inside the lift-applied computation, Reactive auto-unwraps to a plain array, so
//   .map() is a standard Array.prototype.map — it must remain untransformed.
//   This is a negative test for reactive method detection.
export default __cfBindVerifiedBinding(pattern((items) => {
    // items is Reactive<number[]> as a pattern parameter
    // Inside the computed callback (which becomes a lift-applied computation), items.map should NOT be transformed
    const doubled = __cfLift_1({ items: items }).for("doubled", true);
    return doubled;
}, {
    type: "array",
    items: {
        type: "number"
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "number"
    }
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 10, col: 33 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1
});
