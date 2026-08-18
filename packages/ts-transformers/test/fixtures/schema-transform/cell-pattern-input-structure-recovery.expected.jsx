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
import { cell, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// FIXTURE: cell-pattern-input-structure-recovery
// Verifies: `cell(state.values)` preserves array/item structure when the source
// comes from a typed pattern input.
export default __cfBindVerifiedBinding(pattern((state) => {
    const typedValues = cell(state.key("values"), {
        type: "array",
        items: {
            type: "number"
        }
    } as const satisfies __cfHelpers.JSONSchema).for("typedValues", true);
    return { typedValues: typedValues.for(["__patternResult", "typedValues"], true) };
}, {
    type: "object",
    properties: {
        values: {
            type: "array",
            items: {
                type: "number"
            }
        }
    },
    required: ["values"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        typedValues: {
            type: "array",
            items: {
                type: "number"
            },
            asCell: ["cell"]
        }
    },
    required: ["typedValues"]
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 7, col: 45 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
