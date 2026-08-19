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
    counter: __cfHelpers.ReadonlyCell<{ count: number; }>;
}, number>(({ counter }) => {
    const current = counter.get();
    return current.count * 2;
}, {
    type: "object",
    properties: {
        counter: {
            type: "object",
            properties: {
                count: {
                    type: "number"
                }
            },
            required: ["count"],
            asCell: ["readonly"]
        }
    },
    required: ["counter"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
__cfBindVerifiedBinding(__cfLift_1, {
    sourceFile: "/test.tsx",
    position: { line: 11, col: 27 },
    bindingName: "doubled"
});
// FIXTURE: computed-nested-property
// Verifies: computed() capturing a cell with an object value and accessing a nested property
//   computed(() => { const current = counter.get(); return current.count * 2 }) → lift(({ counter }) => { ... })({ counter })
//   The cell schema preserves the nested object shape { count: number } with asCell: true.
export default __cfBindVerifiedBinding(pattern(() => {
    const counter = new Writable({ count: 0 }, {
        type: "object",
        properties: {
            count: {
                type: "number"
            }
        },
        required: ["count"]
    } as const satisfies __cfHelpers.JSONSchema).for("counter", true);
    const doubled = __cfLift_1({ counter: counter }).for("doubled", true);
    return doubled;
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
