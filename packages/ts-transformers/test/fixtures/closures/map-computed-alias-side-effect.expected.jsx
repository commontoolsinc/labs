import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
let keyCounter = 0;
function nextKey() {
    return `value-${keyCounter++}`;
}
interface State {
    items: Array<Record<string, number>>;
}
// FIXTURE: map-computed-alias-side-effect
// Verifies: computed property key with side effects is hoisted and used via derive()
//   { [nextKey()]: amount } → __ct_amount_key = nextKey(); derive(...element[__ct_amount_key])
//   .map(fn) → .mapWithPattern(pattern(...), {})
// Context: nextKey() has side effects (keyCounter++), so the key expression is evaluated once and cached
export default pattern((state) => {
    return {
        [UI]: (<div>
        {state.key("items").mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                const element = __ct_pattern_input.key("element");
                const __ct_amount_key = nextKey();
                const amount = __ctHelpers.derive({
                    type: "object",
                    properties: {
                        element: true,
                        __ct_amount_key: true
                    },
                    required: ["element", "__ct_amount_key"]
                } as const satisfies __ctHelpers.JSONSchema, {
                    type: ["number", "undefined"]
                } as const satisfies __ctHelpers.JSONSchema, {
                    element: element,
                    __ct_amount_key: __ct_amount_key
                }, ({ element, __ct_amount_key }) => element[__ct_amount_key]);
                return (<span>{amount}</span>);
            }, {
                type: "object",
                properties: {
                    element: {
                        type: "object",
                        properties: {},
                        additionalProperties: {
                            type: "number"
                        }
                    }
                },
                required: ["element"]
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
            } as const satisfies __ctHelpers.JSONSchema), {})}
      </div>),
    };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "object",
                properties: {},
                additionalProperties: {
                    type: "number"
                }
            }
        }
    },
    required: ["items"]
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
                    $ref: "#/$defs/UIRenderable"
                }, {
                    type: "object",
                    properties: {}
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
