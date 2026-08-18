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
import { Cell, pattern, action } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface BaseState {
    a?: Cell<string>;
    b: Cell<number>;
}
// Required<BaseState> should make 'a' required in the schema
type ReqState = Required<BaseState>;
const __cfHandler_1 = __cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        a: {
            type: "string",
            asCell: ["writeonly"]
        }
    },
    required: ["a"]
} as const satisfies __cfHelpers.JSONSchema, (_, { a }) => a.set("hello"));
__cfBindVerifiedBinding(__cfHandler_1, {
    sourceFile: "/test.tsx",
    position: { line: 18, col: 17 }
});
const __cfHandler_2 = __cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        b: {
            type: "number",
            asCell: ["writeonly"]
        }
    },
    required: ["b"]
} as const satisfies __cfHelpers.JSONSchema, (_, { b }) => b.set(42));
__cfBindVerifiedBinding(__cfHandler_2, {
    sourceFile: "/test.tsx",
    position: { line: 19, col: 17 }
});
// FIXTURE: action-required-partial
// Verifies: Required<BaseState> makes originally-optional properties required in capture schemas
//   action(() => a.set("hello")) → handler(false, { a: { type: "string", asCell, required } }, ...)({ a })
// Context: BaseState.a is optional, but Required<> forces it to required in both input and capture schemas
export default __cfBindVerifiedBinding(pattern((__cf_pattern_input) => {
    const a = __cf_pattern_input.key("a");
    const b = __cf_pattern_input.key("b");
    return {
        setA: __cfHandler_1({
            a: a
        }).for({ stream: ["__patternResult", "setA"] }, true),
        setB: __cfHandler_2({
            b: b
        }).for({ stream: ["__patternResult", "setB"] }, true)
    };
}, {
    type: "object",
    properties: {
        a: {
            type: "string",
            asCell: ["cell"]
        },
        b: {
            type: "number",
            asCell: ["cell"]
        }
    },
    required: ["a", "b"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        setA: {
            asCell: ["stream", "opaque"]
        },
        setB: {
            asCell: ["stream", "opaque"]
        }
    },
    required: ["setA", "setB"]
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 16, col: 33 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfHandler_1,
    __cfHandler_2
});
