function __ctHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { action, derive, handler, lift, pattern, type Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
// FIXTURE: builder-input-path-shrink
// Verifies: builder input schemas shrink to observed paths when reads/writes are specific,
// including explicit type arguments and interprocedural helper calls.
const liftOptional = lift({
    type: "object",
    properties: {
        foo: {
            type: ["string", "undefined"]
        }
    },
    asCell: true
} as const satisfies __cfHelpers.JSONSchema, {
    type: ["string", "undefined"]
} as const satisfies __cfHelpers.JSONSchema, (input: Writable<{
    foo: string | undefined;
    bar: string;
}>) => input.key("foo").get());
const deriveInput = __cfHelpers.__ct_data({} as Writable<{
    foo: string;
    bar: string;
}>);
const deriveObserved = derive({
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
} as const satisfies __cfHelpers.JSONSchema, deriveInput, (input: Writable<{
    foo: string;
    bar: string;
}>) => input.key("foo").get());
const deriveExplicit = derive({
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
} as const satisfies __cfHelpers.JSONSchema, deriveInput, (value) => value.key("foo").get());
const handlerObserved = handler(false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        foo: {
            type: "string"
        }
    },
    required: ["foo"],
    asCell: true
} as const satisfies __cfHelpers.JSONSchema, (_event: {
    id: string;
}, state: Writable<{
    foo: string;
    bar: string;
}>) => {
    state.key("foo").get();
});
const handlerExplicit = handler({
    type: "object",
    properties: {
        detail: {
            type: "object",
            properties: {
                message: {
                    type: "string"
                }
            },
            required: ["message"]
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
    asCell: true
} as const satisfies __cfHelpers.JSONSchema, (event, state) => {
    event.detail.message;
    state.key("foo").get();
});
const helper = __ctHardenFn((value: Writable<{
    foo: string;
    bar: string;
}>) => value.key("foo").get());
const liftInterprocedural = lift({
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
}>) => helper(input));
const liftWriteOnly = lift({
    type: "object",
    properties: {
        foo: {
            type: "string"
        }
    },
    required: ["foo"],
    asCell: true
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, (input: Writable<{
    foo: string;
    bar: string;
}>) => {
    input.key("foo").set("updated");
    return 1;
});
const liftExplicit = lift({
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
} as const satisfies __cfHelpers.JSONSchema, (input) => input.key("foo").get());
const actionPattern = pattern((input: Writable<{
    foo: string;
    bar: string;
}>) => {
    const a = __cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
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
                asCell: true
            }
        },
        required: ["input"]
    } as const satisfies __cfHelpers.JSONSchema, (_, { input }) => input.key("foo").get())({
        input: input
    });
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
    required: ["foo", "bar"]
} as const satisfies __cfHelpers.JSONSchema, {
    asStream: true
} as const satisfies __cfHelpers.JSONSchema);
export default __cfHelpers.__ct_data({
    liftOptional,
    deriveObserved,
    deriveExplicit,
    handlerObserved,
    handlerExplicit,
    liftInterprocedural,
    liftWriteOnly,
    liftExplicit,
    actionPattern,
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__ctHardenFn(h);
