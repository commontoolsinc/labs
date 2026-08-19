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
import { computed, pattern, type JSONSchema } from "commonfabric";
import "commonfabric/schema";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// Test that pattern with both schemas already present is not transformed
interface Input {
    count: number;
}
interface Result {
    doubled: number;
}
const __cfLift_1 = __cfHelpers.lift<{
    count: number;
}, number>(({ count }) => count * 2, {
    type: "object",
    properties: {
        count: {
            type: "number"
        }
    },
    required: ["count"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
__cfBindVerifiedBinding(__cfLift_1, {
    sourceFile: "/test.tsx",
    position: { line: 17, col: 24 }
});
// FIXTURE: pattern-two-schemas
// Verifies: pattern with both input and output schemas already present preserves them
//   pattern<Input, Result>(fn, inputSchema, outputSchema) → pattern(fn, inputSchema, outputSchema) (schemas kept)
//   ({ count }) destructuring                              → __cf_pattern_input.key("count")
// Context: Schemas are user-provided, not generated; type args are stripped but schemas remain
export default __cfBindVerifiedBinding(pattern((__cf_pattern_input) => {
    const count = __cf_pattern_input.key("count");
    return {
        doubled: __cfLift_1({ count: count }).for(["__patternResult", "doubled"], true)
    };
}, {
    type: "object",
    properties: {
        count: {
            type: "number"
        }
    },
    required: ["count"]
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
    position: { line: 15, col: 2 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1
});
