import * as __ctHelpers from "commontools";
import { computed, pattern, UI } from "commontools";
// FIXTURE: computed-jsx-local-function
// Verifies: computed() with a locally-defined function inside the callback is closure-extracted
//   computed(() => { const format = ...; return <span>{format(count)}</span> }) → derive(captureSchema, resultSchema, { count }, ({ count }) => { ... })
//   The pattern param `count` is captured with asOpaque: true in the schema.
export default pattern((__ct_pattern_input) => {
    const count = __ct_pattern_input.key("count");
    return {
        [UI]: (<div>
        {__ctHelpers.derive({
                type: "object",
                properties: {
                    count: {
                        type: "number"
                    }
                },
                required: ["count"]
            } as const satisfies __ctHelpers.JSONSchema, {
                anyOf: [{
                        $ref: "https://commonfabric.org/schemas/vnode.json"
                    }, {
                        type: "object",
                        properties: {}
                    }, {
                        $ref: "#/$defs/UIRenderable"
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
            } as const satisfies __ctHelpers.JSONSchema, { count: count }, ({ count }) => {
                const format = (value: number) => `Count: ${value}`;
                return <span>{format(count)}</span>;
            })}
      </div>),
    };
}, {
    type: "object",
    properties: {
        count: {
            type: "number"
        }
    },
    required: ["count"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "#/$defs/JSXElement"
        }
    },
    required: ["$UI"],
    $defs: {
        JSXElement: {
            anyOf: [{
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }, {
                    type: "object",
                    properties: {}
                }, {
                    $ref: "#/$defs/UIRenderable"
                }]
        },
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
