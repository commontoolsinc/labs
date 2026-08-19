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
interface Config {
    required: number;
    unionUndefined: number | undefined;
}
const __cfLift_1 = __cfHelpers.lift<{
    value: __cfHelpers.ReadonlyCell<number>;
    config: {
        required: number;
        unionUndefined?: number | undefined;
    };
}, number>(({ value, config }) => value.get() + config.required + (config.unionUndefined ?? 0), {
    type: "object",
    properties: {
        value: {
            type: "number",
            asCell: ["readonly"]
        },
        config: {
            type: "object",
            properties: {
                required: {
                    type: "number"
                },
                unionUndefined: {
                    type: "number"
                }
            },
            required: ["required"]
        }
    },
    required: ["value", "config"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
__cfBindVerifiedBinding(__cfLift_1, {
    sourceFile: "/test.tsx",
    position: { line: 16, col: 26 },
    bindingName: "result"
});
// FIXTURE: computed-union-undefined
// Verifies: captured properties with `number | undefined` union types produce correct schemas
//   computed(() => ...) → lift(...)({ value, config: { required, unionUndefined } })
// Context: `unionUndefined` schema is `type: ["number", "undefined"]`; `required` is plain `number`
export default __cfBindVerifiedBinding(pattern((config: Config) => {
    const value = new Writable(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("value", true);
    const result = __cfLift_1({
        value: value,
        config: {
            required: config.key("required"),
            unionUndefined: config.key("unionUndefined")
        }
    }).for("result", true);
    return result;
}, {
    type: "object",
    properties: {
        required: {
            type: "number"
        },
        unionUndefined: {
            type: ["number", "undefined"]
        }
    },
    required: ["required", "unionUndefined"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 13, col: 23 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1
});
