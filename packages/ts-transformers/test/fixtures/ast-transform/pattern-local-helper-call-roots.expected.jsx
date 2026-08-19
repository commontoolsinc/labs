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
const double = __cfHardenFn((x: number) => x * 2);
const __cfLift_1 = __cfHelpers.lift<{
    state: {
        count: number;
    };
}, number>(({ state }) => double(state.count + 1), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                count: {
                    type: "number"
                }
            },
            required: ["count"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfLift_1, {
    sourceFile: "/test.tsx",
    position: { line: 13, col: 11 }
});
// FIXTURE: pattern-local-helper-call-roots
// Verifies: top-level ordinary local helper calls with reactive inputs are
//   lifted as whole calls, while plain inputs stay plain.
//   double(2)                 -> unchanged plain JS call
//   double(state.count + 1)   -> lift(({ state }) => double(state.count + 1))({ state })
export default __cfBindVerifiedBinding(pattern((state) => ({
    staticDoubled: double(2),
    doubled: __cfLift_1({ state: {
            count: state.key("count")
        } }).for(["__patternResult", "doubled"], true)
}), {
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
        staticDoubled: {
            type: "number"
        },
        doubled: {
            type: "number"
        }
    },
    required: ["staticDoubled", "doubled"]
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 11, col: 42 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1
});
