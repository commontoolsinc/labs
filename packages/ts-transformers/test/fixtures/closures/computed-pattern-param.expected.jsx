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
    value: __cfHelpers.ReadonlyCell<number>;
    config: {
        multiplier: number;
    };
}, number>(({ value, config }) => value.get() * config.multiplier, {
    type: "object",
    properties: {
        value: {
            type: "number",
            asCell: ["readonly"]
        },
        config: {
            type: "object",
            properties: {
                multiplier: {
                    type: "number"
                }
            },
            required: ["multiplier"]
        }
    },
    required: ["value", "config"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
__cfBindVerifiedBinding(__cfLift_1, {
    sourceFile: "/test.tsx",
    position: { line: 12, col: 26 },
    bindingName: "result"
});
// FIXTURE: computed-pattern-param
// Verifies: computed() inside a pattern captures the pattern parameter as a structured object
//   computed(() => value.get() * config.multiplier) → lift(({ value, config }) => ...)({ value, config: { multiplier: config.key("multiplier") } })
// Context: The pattern parameter `config` is not destructured, so properties
//   accessed on it (config.multiplier) are rewritten to config.key("multiplier")
//   in the captures object.
export default __cfBindVerifiedBinding(pattern((config: {
    multiplier: number;
}) => {
    const value = new Writable(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("value", true);
    const result = __cfLift_1({
        value: value,
        config: {
            multiplier: config.key("multiplier")
        }
    }).for("result", true);
    return result;
}, {
    type: "object",
    properties: {
        multiplier: {
            type: "number"
        }
    },
    required: ["multiplier"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 10, col: 23 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1
});
