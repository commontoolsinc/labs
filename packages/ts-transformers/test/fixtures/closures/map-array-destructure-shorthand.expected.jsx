import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
type ItemTuple = [
    item: string,
    count: number
];
interface State {
    items: ItemTuple[];
}
// FIXTURE: map-array-destructure-shorthand
// Verifies: array-destructured map params are not incorrectly captured as shorthand properties
//   .map(([item]) => ...) → .mapWithPattern(pattern(...), {}) with key("element", "0")
//   .map(([item, count], index) → key("element", "0"), key("element", "1"), key("index")
// Context: Shorthand JSX usage like {item} must not cause array-destructured bindings to be captured
export default pattern((__ct_pattern_input) => {
    const items = __ct_pattern_input.key("items");
    return {
        [UI]: (<div>
        {/* Array destructured parameter - without fix, 'item' would be
                incorrectly captured in params due to shorthand usage in JSX */}
        {items.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                const item = __ct_pattern_input.key("element", "0");
                return (<div data-item={item}>{item}</div>);
            }, {
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/ItemTuple"
                    }
                },
                required: ["element"],
                $defs: {
                    ItemTuple: {
                        type: "array",
                        items: {
                            type: ["number", "string"]
                        }
                    }
                }
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

        {/* Multiple array destructured params */}
        {items.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                const item = __ct_pattern_input.key("element", "0");
                const count = __ct_pattern_input.key("element", "1");
                const index = __ct_pattern_input.key("index");
                return (<div key={index}>
            {item}: {count}
          </div>);
            }, {
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/ItemTuple"
                    },
                    index: {
                        type: "number"
                    }
                },
                required: ["element"],
                $defs: {
                    ItemTuple: {
                        type: "array",
                        items: {
                            type: ["number", "string"]
                        }
                    }
                }
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
                $ref: "#/$defs/ItemTuple"
            }
        }
    },
    required: ["items"],
    $defs: {
        ItemTuple: {
            type: "array",
            items: {
                type: ["number", "string"]
            }
        }
    }
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
