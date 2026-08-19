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
    prefix: __cfHelpers.ReadonlyCell<string>;
    value: __cfHelpers.ReadonlyCell<number>;
}, string>(({ prefix, value }) => `${prefix.get()}${value.get()}`, {
    type: "object",
    properties: {
        prefix: {
            type: "string",
            asCell: ["readonly"]
        },
        value: {
            type: "number",
            asCell: ["readonly"]
        }
    },
    required: ["prefix", "value"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
__cfBindVerifiedBinding(__cfLift_1, {
    sourceFile: "/test.tsx",
    position: { line: 11, col: 26 },
    bindingName: "result"
});
// FIXTURE: computed-template-literal
// Verifies: captured cells used inside a template literal expression are extracted
//   computed(() => `${prefix.get()}${value.get()}`) → lift(...)({ value, prefix })
export default __cfBindVerifiedBinding(pattern(() => {
    const value = new Writable(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("value", true);
    const prefix = new Writable("Value: ", {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema).for("prefix", true);
    const result = __cfLift_1({
        prefix: prefix,
        value: value
    }).for("result", true);
    return result;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 7, col: 23 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1
});
