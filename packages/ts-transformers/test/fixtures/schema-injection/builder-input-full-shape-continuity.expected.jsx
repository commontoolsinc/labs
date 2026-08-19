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
import { lift, pattern, type Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// FIXTURE: builder-input-full-shape-continuity
// Verifies: builder input schemas stay conservative/full-shape when the authored contract
// does not justify path shrinking.
const liftWrapped = lift((input: Writable<{
    foo: string;
    bar: string;
}>) => input.get().foo, {
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
__cfBindVerifiedBinding(liftWrapped, {
    sourceFile: "/test.tsx",
    position: { line: 8, col: 25 },
    bindingName: "liftWrapped"
});
const patternFullShape = pattern((input: Writable<{
    foo: string;
    bar: string;
}>) => input.key("foo"), {
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
    type: "string",
    asCell: ["cell"]
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(patternFullShape, {
    sourceFile: "/test.tsx",
    position: { line: 12, col: 33 },
    bindingName: "patternFullShape"
});
const patternExplicit = pattern((input) => input.key("foo"), {
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
    type: "string",
    asCell: ["cell"]
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(patternExplicit, {
    sourceFile: "/test.tsx",
    position: { line: 19, col: 2 },
    bindingName: "patternExplicit"
});
const liftPassthrough = lift((input: Writable<{
    foo: string;
    bar: string;
}>) => input, {
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
    asCell: ["cell"]
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(liftPassthrough, {
    sourceFile: "/test.tsx",
    position: { line: 21, col: 29 },
    bindingName: "liftPassthrough"
});
const helper = __cfHardenFn((value: Writable<{
    foo: string;
    bar: string;
}>) => value.key("foo"));
const patternHelper = pattern((input: Writable<{
    foo: string;
    bar: string;
}>) => helper(input), {
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
    type: "string",
    asCell: ["cell"]
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(patternHelper, {
    sourceFile: "/test.tsx",
    position: { line: 28, col: 30 },
    bindingName: "patternHelper"
});
const wildcardLift = lift((input: Writable<{
    foo: string;
    bar: string;
}>) => {
    const foo = input.key("foo").get();
    Object.keys(input.get());
    return foo;
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
    asCell: ["readonly"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(wildcardLift, {
    sourceFile: "/test.tsx",
    position: { line: 32, col: 26 },
    bindingName: "wildcardLift"
});
export default __cfHelpers.__cf_data({
    liftWrapped,
    patternFullShape,
    patternExplicit,
    liftPassthrough,
    patternHelper,
    wildcardLift,
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    liftWrapped,
    patternFullShape,
    patternExplicit,
    liftPassthrough,
    patternHelper,
    wildcardLift
});
