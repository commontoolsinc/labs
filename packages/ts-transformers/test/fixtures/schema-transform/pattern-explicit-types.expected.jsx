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
import { computed, pattern, } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Input {
    foo: string;
}
interface Output extends Input {
    bar: number;
}
const __cfLift_1 = __cfHelpers.lift<{
    input: { foo: string; } & {} & { [SELF]: Output; };
}, { bar: number; foo: string; [SELF]: Output; }>(({ input }) => ({ ...input, bar: 123 }), {
    type: "object",
    properties: {
        input: {
            type: "object",
            properties: {
                foo: {
                    type: "string"
                }
            },
            required: ["foo"]
        }
    },
    required: ["input"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        bar: {
            type: "number"
        },
        foo: {
            type: "string"
        }
    },
    required: ["bar", "foo"]
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfLift_1, {
    sourceFile: "/test.tsx",
    position: { line: 20, col: 18 }
});
// FIXTURE: pattern-explicit-types
// Verifies: explicit Input and Output type parameters generate separate input/output schemas
//   pattern<Input, Output>() → input schema from Input, output schema from Output (includes inherited fields)
//   Output extends Input → output schema includes both own (bar) and inherited (foo) properties
export default __cfBindVerifiedBinding(pattern((input) => {
    return __cfLift_1({ input: input }).for("__patternResult", true);
}, {
    type: "object",
    properties: {
        foo: {
            type: "string"
        }
    },
    required: ["foo"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        bar: {
            type: "number"
        },
        foo: {
            type: "string"
        }
    },
    required: ["bar", "foo"]
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 19, col: 38 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1
});
