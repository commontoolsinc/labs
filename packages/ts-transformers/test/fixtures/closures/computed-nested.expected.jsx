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
    a: __cfHelpers.ReadonlyCell<number>;
    b: __cfHelpers.ReadonlyCell<number>;
}, number>(({ a, b }) => a.get() + b.get(), {
    type: "object",
    properties: {
        a: {
            type: "number",
            asCell: ["readonly"]
        },
        b: {
            type: "number",
            asCell: ["readonly"]
        }
    },
    required: ["a", "b"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
__cfBindVerifiedBinding(__cfLift_1, {
    sourceFile: "/test.tsx",
    position: { line: 14, col: 23 },
    bindingName: "sum"
});
const __cfLift_2 = __cfHelpers.lift<{
    sum: number;
}, number>(({ sum }) => sum * 2, {
    type: "object",
    properties: {
        sum: {
            type: "number"
        }
    },
    required: ["sum"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
__cfBindVerifiedBinding(__cfLift_2, {
    sourceFile: "/test.tsx",
    position: { line: 15, col: 27 },
    bindingName: "doubled"
});
// FIXTURE: computed-nested
// Verifies: chained computed() calls where the second captures the result of the first
//   computed(() => a.get() + b.get()) → lift(({ a, b }) => a.get() + b.get())({ a, b })
//   computed(() => sum * 2) → lift(({ sum }) => sum * 2)({ sum })
// Context: The first lift-applied computation captures cells (asCell: true), the second captures
//   the computed result (asOpaque: true) since it is a Reactive.
export default __cfBindVerifiedBinding(pattern(() => {
    const a = new Writable(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("a", true);
    const b = new Writable(20, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("b", true);
    const sum = __cfLift_1({
        a: a,
        b: b
    }).for("sum", true);
    const doubled = __cfLift_2({ sum: sum }).for("doubled", true);
    return doubled;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 10, col: 23 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfLift_2
});
