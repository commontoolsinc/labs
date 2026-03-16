import * as __ctHelpers from "commontools";
import { cell, pattern, UI } from "commontools";
// FIXTURE: map-with-array-param-no-name
// Verifies: .map() with array param works when pattern uses inline type annotation
//   .map((item, index, array) => ...) → .mapWithPattern(pattern(...), {})
//   array.length → array.key("length")
// Context: Same as map-with-array-param but with (_state: any) inline annotation instead of type arg
export default pattern((_state: any) => {
    const items = cell([1, 2, 3, 4, 5], {
        type: "array",
        items: {
            type: "number"
        }
    } as const satisfies __ctHelpers.JSONSchema);
    return {
        [UI]: (<div>
        {items.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                const item = __ct_pattern_input.key("element");
                const index = __ct_pattern_input.key("index");
                const array = __ct_pattern_input.key("array");
                return (<div>
            Item {item} at index {index} of {array.key("length")} total items
          </div>);
            }, {
                type: "object",
                properties: {
                    element: {
                        type: "number"
                    },
                    index: {
                        type: "number"
                    },
                    array: {
                        type: "array",
                        items: {
                            type: "number"
                        }
                    }
                },
                required: ["element"]
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
            } as const satisfies __ctHelpers.JSONSchema), {})}
      </div>),
    };
}, false as const satisfies __ctHelpers.JSONSchema, {
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
