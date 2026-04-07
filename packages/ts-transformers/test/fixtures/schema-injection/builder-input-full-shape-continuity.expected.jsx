function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { lift, pattern, type Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
// FIXTURE: builder-input-full-shape-continuity
// Verifies: builder input schemas stay conservative/full-shape when the authored contract
// does not justify path shrinking.
const liftWrapped = lift({
    type: "object",
    properties: {
        foo: {
            type: "string"
        }
    },
    required: ["foo"],
    asCell: true
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema, (input: Writable<{
    foo: string;
    bar: string;
}>) => input.get().foo);
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
    required: ["foo", "bar"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string",
    asCell: true
} as const satisfies __cfHelpers.JSONSchema);
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
    required: ["foo", "bar"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string",
    asCell: true
} as const satisfies __cfHelpers.JSONSchema);
const liftPassthrough = lift({
    type: "object",
    properties: {
        foo: {
            type: "string"
        },
        bar: {
            type: "string"
        }
    },
    required: ["foo", "bar"]
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
    asCell: true
} as const satisfies __cfHelpers.JSONSchema, (input: Writable<{
    foo: string;
    bar: string;
}>) => input);
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
    required: ["foo", "bar"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string",
    asCell: true
} as const satisfies __cfHelpers.JSONSchema);
const wildcardLift = lift({
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
    asCell: true
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema, (input: Writable<{
    foo: string;
    bar: string;
}>) => {
    const foo = input.key("foo").get();
    Object.keys(input.get());
    return foo;
});
export default __cfHelpers.__ct_data({
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
