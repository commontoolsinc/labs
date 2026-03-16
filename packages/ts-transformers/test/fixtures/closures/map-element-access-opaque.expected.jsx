import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
interface State {
    sortedTags: string[];
    tagCounts: Record<string, number>;
}
// FIXTURE: map-element-access-opaque
// Verifies: .map() on reactive array is transformed when callback uses bracket access on a captured opaque object
//   .map(fn) → .mapWithPattern(pattern(...), {state: {tagCounts: ...}})
//   state.tagCounts[tag] → derive() with opaque schema for dynamic key access
// Context: Captures state.tagCounts for bracket-notation element access inside map
export default pattern((state) => {
    return {
        [UI]: (<div>
        {state.key("sortedTags").mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                const tag = __ct_pattern_input.key("element");
                const state = __ct_pattern_input.key("params", "state");
                return (<span>
            {tag}: {__ctHelpers.derive({
                    type: "object",
                    properties: {
                        state: {
                            type: "object",
                            properties: {
                                tagCounts: {
                                    type: "object",
                                    properties: {},
                                    additionalProperties: {
                                        type: "number"
                                    }
                                }
                            },
                            required: ["tagCounts"]
                        },
                        tag: {
                            type: "string"
                        }
                    },
                    required: ["state", "tag"]
                } as const satisfies __ctHelpers.JSONSchema, {
                    anyOf: [{
                            type: "undefined"
                        }, {
                            type: "number"
                        }]
                } as const satisfies __ctHelpers.JSONSchema, {
                    state: {
                        tagCounts: state.key("tagCounts")
                    },
                    tag: tag
                }, ({ state, tag }) => state.tagCounts[tag])}
          </span>);
            }, {
                type: "object",
                properties: {
                    element: {
                        type: "string"
                    },
                    params: {
                        type: "object",
                        properties: {
                            state: {
                                type: "object",
                                properties: {
                                    tagCounts: {
                                        type: "object",
                                        properties: {},
                                        additionalProperties: {
                                            type: "number"
                                        }
                                    }
                                },
                                required: ["tagCounts"]
                            }
                        },
                        required: ["state"]
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
            } as const satisfies __ctHelpers.JSONSchema), {
                state: {
                    tagCounts: state.key("tagCounts")
                }
            })}
      </div>),
    };
}, {
    type: "object",
    properties: {
        sortedTags: {
            type: "array",
            items: {
                type: "string"
            }
        },
        tagCounts: {
            type: "object",
            properties: {},
            additionalProperties: {
                type: "number"
            }
        }
    },
    required: ["sortedTags", "tagCounts"]
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
