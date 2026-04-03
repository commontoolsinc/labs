import * as __ctHelpers from "commontools";
import { lift, pattern, type Writable } from "commontools";
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
} as const satisfies __ctHelpers.JSONSchema, {
    type: "string"
} as const satisfies __ctHelpers.JSONSchema, (input: Writable<{
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
} as const satisfies __ctHelpers.JSONSchema, {
    type: "string",
    asCell: true
} as const satisfies __ctHelpers.JSONSchema);
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
} as const satisfies __ctHelpers.JSONSchema, {
    type: "string",
    asCell: true
} as const satisfies __ctHelpers.JSONSchema);
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
} as const satisfies __ctHelpers.JSONSchema, {
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
} as const satisfies __ctHelpers.JSONSchema, (input: Writable<{
    foo: string;
    bar: string;
}>) => input);
const helper = (value: Writable<{
    foo: string;
    bar: string;
}>) => value.key("foo");
const patternHelper = pattern((input: Writable<{
    foo: string;
    bar: string;
}>) => __ctHelpers.derive({
    type: "object",
    properties: {
        input: {
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
        }
    },
    required: ["input"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "string",
    asCell: true
} as const satisfies __ctHelpers.JSONSchema, { input: input }, ({ input }) => helper(input)), {
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
} as const satisfies __ctHelpers.JSONSchema, {
    type: "string",
    asCell: true
} as const satisfies __ctHelpers.JSONSchema);
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
} as const satisfies __ctHelpers.JSONSchema, {
    type: "string"
} as const satisfies __ctHelpers.JSONSchema, (input: Writable<{
    foo: string;
    bar: string;
}>) => {
    const foo = input.key("foo").get();
    Object.keys(input.get());
    return foo;
});
export default {
    liftWrapped,
    patternFullShape,
    patternExplicit,
    liftPassthrough,
    patternHelper,
    wildcardLift,
};
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
