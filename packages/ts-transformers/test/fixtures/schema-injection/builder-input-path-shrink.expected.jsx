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
import { action, computed, handler, lift, pattern, type Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// FIXTURE: builder-input-path-shrink
// Verifies: builder input schemas shrink to observed paths when reads/writes are specific,
// including explicit type arguments and interprocedural helper calls.
const liftOptional = lift((input: Writable<{
    foo: string | undefined;
    bar: string;
}>) => input.key("foo").get(), {
    type: "object",
    properties: {
        foo: {
            type: "string"
        }
    },
    asCell: ["readonly"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: ["string", "undefined"]
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(liftOptional, {
    sourceFile: "/test.tsx",
    position: { line: 8, col: 26 },
    bindingName: "liftOptional"
});
const deriveInput: Writable<{
    foo: string;
    bar: string;
}> = __cfHelpers.__cf_data({} as never);
const __cfLift_1 = __cfHelpers.lift(() => deriveInput.key("foo").get(), false, undefined, { completeSchedulerScopeSummary: true });
__cfBindVerifiedBinding(__cfLift_1, {
    sourceFile: "/test.tsx",
    position: { line: 13, col: 34 },
    bindingName: "computedObserved"
});
const computedObserved = __cfHelpers.__cf_data(__cfLift_1().for("computedObserved", true));
const handlerObserved = handler(false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        foo: {
            type: "string"
        }
    },
    required: ["foo"],
    asCell: ["readonly"]
} as const satisfies __cfHelpers.JSONSchema, (_event: {
    id: string;
}, state: Writable<{
    foo: string;
    bar: string;
}>) => {
    state.key("foo").get();
});
__cfBindVerifiedBinding(handlerObserved, {
    sourceFile: "/test.tsx",
    position: { line: 16, col: 2 },
    bindingName: "handlerObserved"
});
const handlerExplicit = handler({
    type: "object",
    properties: {
        detail: {
            type: "object",
            properties: {
                message: {
                    type: "string"
                },
                unused: {
                    type: "number"
                }
            },
            required: ["message", "unused"]
        }
    },
    required: ["detail"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        foo: {
            type: "string"
        }
    },
    required: ["foo"],
    asCell: ["readonly"]
} as const satisfies __cfHelpers.JSONSchema, (event, state) => {
    event.detail.message;
    state.key("foo").get();
});
__cfBindVerifiedBinding(handlerExplicit, {
    sourceFile: "/test.tsx",
    position: { line: 24, col: 2 },
    bindingName: "handlerExplicit"
});
const helper = __cfHardenFn((value: Writable<{
    foo: string;
    bar: string;
}>) => value.key("foo").get());
const liftInterprocedural = lift((input: Writable<{
    foo: string;
    bar: string;
}>) => helper(input), {
    type: "object",
    properties: {
        foo: {
            type: "string"
        }
    },
    required: ["foo"],
    asCell: ["readonly"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(liftInterprocedural, {
    sourceFile: "/test.tsx",
    position: { line: 32, col: 33 },
    bindingName: "liftInterprocedural"
});
const liftWriteOnly = lift((input: Writable<{
    foo: string;
    bar: string;
}>) => {
    input.key("foo").set("updated");
    return 1;
}, {
    type: "object",
    properties: {
        foo: {
            type: "string"
        }
    },
    required: ["foo"],
    asCell: ["writeonly"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(liftWriteOnly, {
    sourceFile: "/test.tsx",
    position: { line: 36, col: 27 },
    bindingName: "liftWriteOnly"
});
const liftExplicit = lift((input) => input.key("foo").get(), {
    type: "object",
    properties: {
        foo: {
            type: "string"
        }
    },
    required: ["foo"],
    asCell: ["readonly"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(liftExplicit, {
    sourceFile: "/test.tsx",
    position: { line: 42, col: 2 },
    bindingName: "liftExplicit"
});
const __cfHandler_1 = __cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        input: {
            type: "object",
            properties: {
                foo: {
                    type: "string"
                }
            },
            required: ["foo"],
            asCell: ["readonly"]
        }
    },
    required: ["input"]
} as const satisfies __cfHelpers.JSONSchema, (_, { input }) => input.key("foo").get());
__cfBindVerifiedBinding(__cfHandler_1, {
    sourceFile: "/test.tsx",
    position: { line: 46, col: 19 },
    bindingName: "a"
});
const actionPattern = pattern((input: Writable<{
    foo: string;
    bar: string;
}>) => {
    const a = __cfHandler_1({
        input: input
    }).for({ stream: "a" }, true);
    return a;
}, {
    type: "object",
    properties: {
        foo: {
            type: "string"
        },
        bar: {
            type: "string"
        }
    },
    required: ["foo", "bar"],
    asCell: ["opaque"]
} as const satisfies __cfHelpers.JSONSchema, {
    asCell: ["stream", "opaque"]
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(actionPattern, {
    sourceFile: "/test.tsx",
    position: { line: 45, col: 30 },
    bindingName: "actionPattern"
});
export default __cfHelpers.__cf_data({
    liftOptional,
    computedObserved,
    handlerObserved,
    handlerExplicit,
    liftInterprocedural,
    liftWriteOnly,
    liftExplicit,
    actionPattern,
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    liftOptional,
    __cfLift_1,
    handlerObserved,
    handlerExplicit,
    liftInterprocedural,
    liftWriteOnly,
    liftExplicit,
    actionPattern,
    __cfHandler_1
});
