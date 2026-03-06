import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
interface Group {
    name: string;
    members: string[];
}
interface State {
    groups: Group[];
}
// FIXTURE: flatmap-basic
// Verifies: .flatMap() and .map() on reactive arrays are both transformed
//   .flatMap(fn) → .flatMapWithPattern(pattern(...), {})
//   .map(fn)     → .mapWithPattern(pattern(...), {})
// Context: flatMap expands each group into its members array, then map
//   renders each. No captured outer variables — params objects are empty {}
export default pattern((state) => {
    return {
        [UI]: (<ul>
        {state.groups.flatMapWithPattern(__ctHelpers.pattern(({ element: group, params: {} }) => group.members, {
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Group"
                    },
                    params: {
                        type: "object",
                        properties: {}
                    }
                },
                required: ["element", "params"],
                $defs: {
                    Group: {
                        type: "object",
                        properties: {
                            name: {
                                type: "string"
                            },
                            members: {
                                type: "array",
                                items: {
                                    type: "string"
                                }
                            }
                        },
                        required: ["name", "members"]
                    }
                }
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "array",
                items: {
                    type: "string"
                },
                asOpaque: true
            } as const satisfies __ctHelpers.JSONSchema), {}).mapWithPattern(__ctHelpers.pattern(({ element: member, params: {} }) => (<li>{member}</li>), {
                type: "object",
                properties: {
                    element: true,
                    params: {
                        type: "object",
                        properties: {}
                    }
                },
                required: ["element", "params"]
            } as const satisfies __ctHelpers.JSONSchema, {
                anyOf: [{
                        $ref: "https://commonfabric.org/schemas/vnode.json"
                    }, {
                        type: "object",
                        properties: {}
                    }, {
                        $ref: "#/$defs/UIRenderable",
                        asOpaque: true
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
        groups: {
            type: "array",
            items: {
                $ref: "#/$defs/Group"
            }
        }
    },
    required: ["groups"],
    $defs: {
        Group: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                members: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                }
            },
            required: ["name", "members"]
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
                    $ref: "#/$defs/UIRenderable",
                    asOpaque: true
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
