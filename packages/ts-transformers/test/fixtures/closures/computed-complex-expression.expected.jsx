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
    c: __cfHelpers.ReadonlyCell<number>;
}, number>(({ a, b, c }) => (a.get() * b.get() + c.get()) / 2, {
    type: "object",
    properties: {
        a: {
            type: "number",
            asCell: ["readonly"]
        },
        b: {
            type: "number",
            asCell: ["readonly"]
        },
        c: {
            type: "number",
            asCell: ["readonly"]
        }
    },
    required: ["a", "b", "c"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
__cfBindVerifiedBinding(__cfLift_1, {
    sourceFile: "/test.tsx",
    position: { line: 13, col: 26 },
    bindingName: "result"
});
// FIXTURE: computed-complex-expression
// Verifies: computed(() => expr) with three cell captures in an arithmetic expression
//   computed(() => (a.get() * b.get() + c.get()) / 2) → lift(({ a, b, c }) => ...)({ a, b, c })
//   All three cells (a, b, c) are captured with asCell: true in the schema.
export default __cfBindVerifiedBinding(pattern(() => {
    const a = new Writable(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("a", true);
    const b = new Writable(20, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("b", true);
    const c = new Writable(5, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("c", true);
    const result = __cfLift_1({
        a: a,
        b: b,
        c: c
    }).for("result", true);
    return result;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
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
