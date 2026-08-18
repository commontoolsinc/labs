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
import { computed, ifElse, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const __cfLift_1 = __cfHelpers.lift<{
    bar: boolean;
}, "B" | "C">(({ bar }) => bar ? "B" : "C", {
    type: "object",
    properties: {
        bar: {
            type: "boolean"
        }
    },
    required: ["bar"]
} as const satisfies __cfHelpers.JSONSchema, {
    "enum": ["B", "C"]
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
__cfBindVerifiedBinding(__cfLift_1, {
    sourceFile: "/test.tsx",
    position: { line: 11, col: 24 }
});
// FIXTURE: computed-boundary-nested-ternaries
// Verifies: outer branch lowering does not structurally lower nested ternaries inside computed callbacks
//   show ? computed(() => bar ? "B" : "C") : "D" → outer branch lowers, inner ternary stays authored
//   ifElse(show, computed(() => foo ? "A" : bar ? "B" : "C"), "D") → helper-owned branch lowering still preserves the inner ternaries
export const OuterTernary = __cfBindVerifiedBinding(pattern((__cf_pattern_input) => {
    const show = __cf_pattern_input.key("show");
    const bar = __cf_pattern_input.key("bar");
    return (<div>{__cfHelpers.ifElse({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        "enum": ["B", "C"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        "enum": ["B", "C", "D"]
    } as const satisfies __cfHelpers.JSONSchema, show, __cfLift_1({ bar: bar }), "D")}</div>);
}, {
    type: "object",
    properties: {
        show: {
            type: "boolean"
        },
        bar: {
            type: "boolean"
        }
    },
    required: ["show", "bar"]
} as const satisfies __cfHelpers.JSONSchema, {
    anyOf: [{
            $ref: "https://commonfabric.org/schemas/vnode.json"
        }, {
            $ref: "#/$defs/UIRenderable"
        }, {
            type: "object",
            properties: {}
        }],
    $defs: {
        UIRenderable: {
            type: "object",
            properties: {
                $UI: {
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }
            },
            required: ["$UI"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 8, col: 69 },
    bindingName: "OuterTernary"
});
const __cfLift_2 = __cfHelpers.lift<{
    foo: boolean;
    bar: boolean;
}, "A" | "B" | "C">(({ foo, bar }) => foo ? "A" : bar ? "B" : "C", {
    type: "object",
    properties: {
        foo: {
            type: "boolean"
        },
        bar: {
            type: "boolean"
        }
    },
    required: ["foo", "bar"]
} as const satisfies __cfHelpers.JSONSchema, {
    "enum": ["A", "B", "C"]
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
__cfBindVerifiedBinding(__cfLift_2, {
    sourceFile: "/test.tsx",
    position: { line: 19, col: 24 }
});
export const AuthoredIfElse = __cfBindVerifiedBinding(pattern((__cf_pattern_input) => {
    const show = __cf_pattern_input.key("show");
    const foo = __cf_pattern_input.key("foo");
    const bar = __cf_pattern_input.key("bar");
    return ifElse({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        "enum": ["A", "B", "C"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        "enum": ["A", "B", "C", "D"]
    } as const satisfies __cfHelpers.JSONSchema, show, __cfLift_2({
        foo: foo,
        bar: bar
    }), "D");
}, {
    type: "object",
    properties: {
        show: {
            type: "boolean"
        },
        foo: {
            type: "boolean"
        },
        bar: {
            type: "boolean"
        }
    },
    required: ["show", "foo", "bar"]
} as const satisfies __cfHelpers.JSONSchema, {
    "enum": ["A", "B", "C", "D"]
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 18, col: 3 },
    bindingName: "AuthoredIfElse"
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfLift_2
});
