import * as __ctHelpers from "commontools";
import { computed, pattern } from "commontools";
// FIXTURE: pattern-vs-computed-logical-and
// Verifies: top-level pattern JSX logical roots lower structurally, but computed-owned logical roots stay authored
//   <div>{foo && name}</div> in a pattern body → __ctHelpers.when(...)
//   <div>{computed(() => foo && bar)}</div> keeps the authored && inside the computed callback
export const PatternLogicalAnd = pattern((__ct_pattern_input) => {
    const foo = __ct_pattern_input.key("foo");
    const name = __ct_pattern_input.key("user", "name");
    return (<div>{__ctHelpers.when({
        type: "boolean"
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __ctHelpers.JSONSchema, {
        type: ["boolean", "string"]
    } as const satisfies __ctHelpers.JSONSchema, foo, name)}</div>);
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
export const ComputedLogicalAnd = pattern((__ct_pattern_input) => {
    const foo = __ct_pattern_input.key("foo");
    const bar = __ct_pattern_input.key("bar");
    return (<div>{__ctHelpers.derive({
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
    } as const satisfies __ctHelpers.JSONSchema, {
        anyOf: [{
                type: "string"
            }, {
                type: "boolean",
                "enum": [false]
            }]
    } as const satisfies __ctHelpers.JSONSchema, {
        foo: foo,
        bar: bar
    }, ({ foo, bar }) => foo && bar)}</div>);
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
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
