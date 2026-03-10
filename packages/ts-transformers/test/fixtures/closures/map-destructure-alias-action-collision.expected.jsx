import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
interface Spot {
    spotNumber: string;
}
interface State {
    spots: Spot[];
}
// FIXTURE: map-destructure-alias-action-collision
// Verifies: destructured alias inside map callback body is preserved as-is in the output
//   const { spotNumber: sn } = spot → kept as destructure from the element binding
//   .map(fn) → .mapWithPattern(pattern(...), {})
// Context: Alias is in the callback body (not the parameter), so no lowering to key() is needed
export default pattern((state) => {
    return {
        [UI]: (<ul>
        {state.key("spots").mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                const spot = __ct_pattern_input.key("element");
                const { spotNumber: sn } = spot;
                return <li>{sn}</li>;
            }, {
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Spot"
                    }
                },
                required: ["element"],
                $defs: {
                    Spot: {
                        type: "object",
                        properties: {
                            spotNumber: {
                                type: "string"
                            }
                        },
                        required: ["spotNumber"]
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
      </ul>),
    };
}, {
    type: "object",
    properties: {
        spots: {
            type: "array",
            items: {
                $ref: "#/$defs/Spot"
            }
        }
    },
    required: ["spots"],
    $defs: {
        Spot: {
            type: "object",
            properties: {
                spotNumber: {
                    type: "string"
                }
            },
            required: ["spotNumber"]
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
