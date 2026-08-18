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
import { computed, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// FIXTURE: pattern-vs-computed-logical-and
// Verifies: top-level pattern JSX logical roots lower structurally, but computed-owned logical roots stay authored
//   <div>{foo && name}</div> in a pattern body → __cfHelpers.when(...)
//   <div>{computed(() => foo && bar)}</div> keeps the authored && inside the computed callback
export const PatternLogicalAnd = __cfBindVerifiedBinding(pattern((__cf_pattern_input) => {
    const foo = __cf_pattern_input.key("foo");
    const name = __cf_pattern_input.key("user", "name");
    return (<div>{__cfHelpers.when({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: ["boolean", "string"]
    } as const satisfies __cfHelpers.JSONSchema, foo, name)}</div>);
}, {
    type: "object",
    properties: {
        foo: {
            type: "boolean"
        },
        user: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        }
    },
    required: ["foo", "user"]
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
    position: { line: 11, col: 3 },
    bindingName: "PatternLogicalAnd"
});
const __cfLift_1 = __cfHelpers.lift<{
    foo: boolean;
    bar: string;
}, string | false>(({ foo, bar }) => foo && bar, {
    type: "object",
    properties: {
        foo: {
            type: "boolean"
        },
        bar: {
            type: "string"
        }
    },
    required: ["foo", "bar"]
} as const satisfies __cfHelpers.JSONSchema, {
    anyOf: [{
            type: "string"
        }, {
            type: "boolean",
            "enum": [false]
        }]
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
__cfBindVerifiedBinding(__cfLift_1, {
    sourceFile: "/test.tsx",
    position: { line: 18, col: 17 }
});
export const ComputedLogicalAnd = __cfBindVerifiedBinding(pattern((__cf_pattern_input) => {
    const foo = __cf_pattern_input.key("foo");
    const bar = __cf_pattern_input.key("bar");
    return (<div>{__cfLift_1({
        foo: foo,
        bar: bar
    })}</div>);
}, {
    type: "object",
    properties: {
        foo: {
            type: "boolean"
        },
        bar: {
            type: "string"
        }
    },
    required: ["foo", "bar"]
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
    position: { line: 15, col: 73 },
    bindingName: "ComputedLogicalAnd"
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1
});
