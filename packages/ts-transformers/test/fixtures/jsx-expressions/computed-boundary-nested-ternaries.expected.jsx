import * as __ctHelpers from "commontools";
import { computed, ifElse, pattern } from "commontools";
// FIXTURE: computed-boundary-nested-ternaries
// Verifies: outer branch lowering does not structurally lower nested ternaries inside computed callbacks
//   show ? computed(() => bar ? "B" : "C") : "D" → outer branch lowers, inner ternary stays authored
//   ifElse(show, computed(() => foo ? "A" : bar ? "B" : "C"), "D") → helper-owned branch lowering still preserves the inner ternaries
export const OuterTernary = pattern((__ct_pattern_input) => {
    const show = __ct_pattern_input.key("show");
    const bar = __ct_pattern_input.key("bar");
    return (<div>{__ctHelpers.ifElse({
        type: "boolean"
    } as const satisfies __ctHelpers.JSONSchema, {
        "enum": ["B", "C"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __ctHelpers.JSONSchema, {
        "enum": ["B", "C", "D"]
    } as const satisfies __ctHelpers.JSONSchema, show, __ctHelpers.derive({
        type: "object",
        properties: {
            bar: {
                type: "boolean"
            }
        },
        required: ["bar"]
    } as const satisfies __ctHelpers.JSONSchema, {
        "enum": ["B", "C"]
    } as const satisfies __ctHelpers.JSONSchema, { bar: bar }, ({ bar }) => bar ? "B" : "C"), "D")}</div>);
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
} as const satisfies __ctHelpers.JSONSchema, {
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
} as const satisfies __ctHelpers.JSONSchema);
export const AuthoredIfElse = pattern((__ct_pattern_input) => {
    const show = __ct_pattern_input.key("show");
    const foo = __ct_pattern_input.key("foo");
    const bar = __ct_pattern_input.key("bar");
    return ifElse({
        type: "boolean"
    } as const satisfies __ctHelpers.JSONSchema, {
        "enum": ["B", "C", "A"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __ctHelpers.JSONSchema, {
        "enum": ["B", "C", "A", "D"]
    } as const satisfies __ctHelpers.JSONSchema, show, __ctHelpers.derive({
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
    } as const satisfies __ctHelpers.JSONSchema, {
        "enum": ["B", "C", "A"]
    } as const satisfies __ctHelpers.JSONSchema, {
        foo: foo,
        bar: bar
    }, ({ foo, bar }) => foo ? "A" : bar ? "B" : "C"), "D");
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
} as const satisfies __ctHelpers.JSONSchema, {
    "enum": ["B", "C", "A", "D"]
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
