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
import { lift, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// FIXTURE: cfreg-export-forms
// Verifies which top-level builder artifacts are routed through `__cfReg`:
// - a NON-exported top-level builder const IS registered (by its binding name);
// - artifacts that leave via ANY export form are NOT (they are addressable
//   through the module namespace by their export name): inline `export const`,
//   a separate `export { ... }`, and a default export.
// The trailing `__cfReg({ ... })` should therefore contain only `internalHelper`
// and the synthetic `__cfPattern_1` (the `.map` op) — never `exportedLift`,
// `reexportedLift`, or the default pattern.
const internalHelper = lift((x: number) => x + 1, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(internalHelper, {
    sourceFile: "/test.tsx",
    position: { line: 14, col: 28 },
    bindingName: "internalHelper"
});
export const exportedLift = __cfBindVerifiedBinding(lift((x: number) => x * 2, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 16, col: 33 },
    bindingName: "exportedLift"
});
const reexportedLift = lift((x: number) => x - 1, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(reexportedLift, {
    sourceFile: "/test.tsx",
    position: { line: 18, col: 28 },
    bindingName: "reexportedLift"
});
export { reexportedLift };
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const x = __cf_pattern_input.key("element");
    return internalHelper(x).for("__patternResult", true);
}, {
    type: "object",
    properties: {
        element: {
            type: "number"
        }
    },
    required: ["element"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfPattern_1, {
    sourceFile: "/test.tsx",
    position: { line: 22, col: 16 }
});
export default __cfBindVerifiedBinding(pattern((__cf_pattern_input) => {
    const items = __cf_pattern_input.key("items");
    return ({
        vs: items.mapWithPattern(__cfPattern_1, {}).for(["__patternResult", "vs"], true)
    });
}, {
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
    type: "object",
    properties: {
        vs: {
            type: "array",
            items: {
                type: "number"
            }
        }
    },
    required: ["vs"]
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 21, col: 44 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    internalHelper,
    __cfPattern_1
});
