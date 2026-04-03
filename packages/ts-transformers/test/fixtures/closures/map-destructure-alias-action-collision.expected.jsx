import * as __cfHelpers from "commonfabric";
import { pattern, UI } from "commonfabric";
interface Spot {
    spotNumber: string;
}
interface State {
    spots: Spot[];
}
// FIXTURE: map-destructure-alias-action-collision
// Verifies: destructured alias inside map callback body is lowered to explicit key() access
//   const { spotNumber: sn } = spot → const sn = spot.key("spotNumber")
//   .map(fn) → .mapWithPattern(pattern(...), {})
// Context: Body destructuring from opaque map elements becomes explicit key() bindings
export default pattern((state) => {
    return {
        [UI]: (<ul>
        {state.key("spots").mapWithPattern(__cfHelpers.pattern(__ct_pattern_input => {
                const spot = __ct_pattern_input.key("element");
                const sn = spot.key("spotNumber");
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
            } as const satisfies __cfHelpers.JSONSchema), {})}
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
} as const satisfies __cfHelpers.JSONSchema, {
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
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
