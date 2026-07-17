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
// Verifies: a typed local cell fed from a pattern input via `.set(...)`
// preserves array/item structure in its injected schema.
// Cell initials are schema defaults and must be compile-time static
// (CT-1880); the former `cell(state.values)` spelling is now a diagnostic —
// runtime values arrive via `.set(...)`.
export default pattern((state) => {
    const typedValues = cell<number[]>([], {
        type: "array",
        items: {
            type: "number"
        }
    } as const satisfies __cfHelpers.JSONSchema).for("typedValues", true);
    typedValues.set(state.key("values"));
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
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
