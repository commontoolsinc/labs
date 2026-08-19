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
import { lift } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
type LiftArgs = {
    value: number;
};
type LiftResult = {
    doubled: number;
};
// FIXTURE: schema-generation-lift-no-generics
// Verifies: lift() with no generic type args infers schemas from inline param and return type
//   lift((args: LiftArgs): LiftResult => ...) → lift(inputSchema, outputSchema, fn)
// Context: Types come from function parameter and return type annotations, not generic args
export const doubleValue = __cfBindVerifiedBinding(lift((args: LiftArgs): LiftResult => ({
    doubled: args.value * 2,
}), {
    type: "object",
    properties: {
        value: {
            type: "number"
        }
    },
    required: ["value"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        doubled: {
            type: "number"
        }
    },
    required: ["doubled"]
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 16, col: 32 },
    bindingName: "doubleValue"
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
