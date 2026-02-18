import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
interface State {
    sortedTags: string[];
    tagCounts: Record<string, number>;
}
export default pattern((state) => {
    return {
        [UI]: (<div>
        {state.sortedTags.mapWithPattern(__ctHelpers.pattern(({ element: tag, params: { state } }) => (<span>
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
                                },
                                asOpaque: true
                            }
                        },
                        required: ["tagCounts"]
                    },
                    tag: {
                        type: "string",
                        asOpaque: true
                    }
                },
                required: ["state", "tag"]
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "number",
                asOpaque: true
            } as const satisfies __ctHelpers.JSONSchema, {
                state: {
                    tagCounts: state.tagCounts
                },
                tag: tag
            }, ({ state, tag }) => state.tagCounts[tag])}
          </span>), {
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
                                        },
                                        asOpaque: true
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
            } as const satisfies __ctHelpers.JSONSchema), {
                state: {
                    tagCounts: state.tagCounts
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
