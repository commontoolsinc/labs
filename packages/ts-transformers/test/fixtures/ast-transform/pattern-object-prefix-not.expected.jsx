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
import { pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const __cfLift_1 = __cfHelpers.lift<{
    state: {
        done: boolean;
    };
}, boolean>(({ state }) => !state.done, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                done: {
                    type: "boolean"
                }
            },
            required: ["done"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfLift_1, {
    sourceFile: "/test.tsx",
    position: { line: 10, col: 10 }
});
// FIXTURE: pattern-object-prefix-not
// Verifies: top-level non-JSX unary boolean negation in an object property is
//   lowered after closure normalization into a direct lift-applied computation.
//   return { hidden: !state.done }
//   → return { hidden: lift(({ state }) => !state.done)({ state }) }
export default __cfBindVerifiedBinding(pattern((state) => ({
    hidden: __cfLift_1({ state: {
            done: state.key("done")
        } }).for(["__patternResult", "hidden"], true)
}), {
    type: "object",
    properties: {
        done: {
            type: "boolean"
        }
    },
    required: ["done"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        hidden: {
            type: "boolean"
        }
    },
    required: ["hidden"]
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 9, col: 42 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1
});
