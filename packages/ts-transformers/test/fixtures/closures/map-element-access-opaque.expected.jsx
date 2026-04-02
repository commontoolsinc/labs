function __ctHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
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
        {state.key("sortedTags").mapWithPattern(__cfHelpers.pattern(__ct_pattern_input => {
                const tag = __ct_pattern_input.key("element");
                const state = __ct_pattern_input.key("params", "state");
                return (<span>
            {tag}: {__cfHelpers.derive({
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
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: ["number", "undefined"]
                } as const satisfies __cfHelpers.JSONSchema, {
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
            } as const satisfies __cfHelpers.JSONSchema), {
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
__ctHardenFn(h);
