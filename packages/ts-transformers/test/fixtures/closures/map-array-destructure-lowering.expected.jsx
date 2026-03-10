import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
type Row = [
    left: string,
    right: string
];
interface State {
    rows: Row[];
}
// FIXTURE: map-array-destructure-lowering
// Verifies: array destructuring in .map() callback is lowered to index-based key access
//   .map(([left, right]) => ...) → .mapWithPattern(pattern(...), {})
//   [left, right] → key("element", "0"), key("element", "1")
export default pattern((state) => {
    return {
        [UI]: (<div>
        {state.key("rows").mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                const left = __ct_pattern_input.key("element", "0");
                const right = __ct_pattern_input.key("element", "1");
                return (<span>
            {left}:{right}
          </span>);
            }, {
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Row"
                    }
                },
                required: ["element"],
                $defs: {
                    Row: {
                        type: "array",
                        items: {
                            type: "string"
                        }
                    }
                }
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
}, {
    type: "object",
    properties: {
        rows: {
            type: "array",
            items: {
                $ref: "#/$defs/Row"
            }
        }
    },
    required: ["rows"],
    $defs: {
        Row: {
            type: "array",
            items: {
                type: "string"
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
