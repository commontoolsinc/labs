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
    config: __cfHelpers.ReadonlyCell<{
        multiplier?: number;
    } | null>;
}, number>(({ value, config }) => value.get() * (config.get()?.multiplier ?? 1), {
    type: "object",
    properties: {
        value: {
            type: "number",
            asCell: ["readonly"]
        },
        config: {
            anyOf: [{
                    type: "object",
                    properties: {
                        multiplier: {
                            type: "number"
                        }
                    }
                }, {
                    type: "null"
                }],
            asCell: ["readonly"]
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
// FIXTURE: computed-optional-chaining
// Verifies: computed() with optional chaining and nullish coalescing on captured cells
//   computed(() => value.get() * (config.get()?.multiplier ?? 1)) → lift(({ value, config }) => ...)({ value, config })
//   The config cell has a nullable type (anyOf [object, null]) with asCell: true in the capture schema.
export default __cfBindVerifiedBinding(pattern(() => {
    const config = new Writable<{
        multiplier?: number;
    } | null>({ multiplier: 2 }, {
        anyOf: [{
                type: "object",
                properties: {
                    multiplier: {
                        type: "number"
                    }
                }
            }, {
                type: "null"
            }]
    } as const satisfies __cfHelpers.JSONSchema).for("config", true);
    const value = new Writable(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("value", true);
    const result = __cfLift_1({
        value: value,
        config: config
    }).for("result", true);
    return result;
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
