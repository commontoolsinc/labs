import * as __ctHelpers from "commontools";
/**
 * Regression test for array.length access inside computed().
 *
 * This mimics the pattern from default-app.tsx where:
 * - allCharms comes from wish<{ allCharms: MentionableCharm[] }>
 * - computed(() => allCharms.length) accesses .length on an OpaqueRef<T[]>
 *
 * The fix ensures the schema is { type: "array", items: { not: true, asOpaque: true } }
 * rather than { type: "object", properties: { length: { type: "number" } } }
 */
import { computed, NAME, pattern, UI, wish } from "commontools";
interface Charm {
    id: string;
    name: string;
}
export default pattern(() => {
    const { allCharms } = wish<{
        allCharms: Charm[];
    }>("/", {
        type: "object",
        properties: {
            allCharms: {
                type: "array",
                items: {
                    $ref: "#/$defs/Charm"
                }
            }
        },
        required: ["allCharms"],
        $defs: {
            Charm: {
                type: "object",
                properties: {
                    id: {
                        type: "string"
                    },
                    name: {
                        type: "string"
                    }
                },
                required: ["id", "name"]
            }
        }
    } as const satisfies __ctHelpers.JSONSchema);
    return {
        [NAME]: __ctHelpers.derive({
            type: "object",
            properties: {
                allCharms: {
                    type: "object",
                    properties: {
                        length: {
                            type: "number"
                        }
                    },
                    required: ["length"]
                }
            },
            required: ["allCharms"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { allCharms: {
                length: allCharms.length
            } }, ({ allCharms }) => `Charms (${allCharms.length})`),
        [UI]: (<div>
        <span>Count: {__ctHelpers.derive({
            type: "object",
            properties: {
                allCharms: {
                    type: "object",
                    properties: {
                        length: {
                            type: "number"
                        }
                    },
                    required: ["length"]
                }
            },
            required: ["allCharms"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { allCharms: {
                length: allCharms.length
            } }, ({ allCharms }) => allCharms.length)}</span>
        <ul>
          {allCharms.mapWithPattern(__ctHelpers.recipe({
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Charm"
                    },
                    params: {
                        type: "object",
                        properties: {}
                    }
                },
                required: ["element", "params"],
                $defs: {
                    Charm: {
                        type: "object",
                        properties: {
                            id: {
                                type: "string"
                            },
                            name: {
                                type: "string"
                            }
                        },
                        required: ["id", "name"]
                    }
                }
            } as const satisfies __ctHelpers.JSONSchema, {
                anyOf: [{
                        $ref: "#/$defs/VNode"
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
                                $ref: "#/$defs/VNode"
                            }
                        },
                        required: ["$UI"]
                    },
                    VNode: {
                        type: "object",
                        properties: {
                            type: {
                                type: "string",
                                "enum": ["vnode"]
                            },
                            name: {
                                type: "string"
                            },
                            props: {
                                $ref: "#/$defs/Props"
                            },
                            children: {
                                $ref: "#/$defs/RenderNode"
                            },
                            $UI: {
                                $ref: "#/$defs/VNode"
                            }
                        },
                        required: ["type", "name", "props"]
                    },
                    RenderNode: {
                        anyOf: [{
                                type: "string"
                            }, {
                                type: "number"
                            }, {
                                type: "boolean",
                                "enum": [false]
                            }, {
                                type: "boolean",
                                "enum": [true]
                            }, {
                                $ref: "#/$defs/VNode"
                            }, {
                                type: "object",
                                properties: {}
                            }, {
                                $ref: "#/$defs/UIRenderable",
                                asOpaque: true
                            }, {
                                type: "object",
                                properties: {}
                            }, {
                                type: "array",
                                items: {
                                    $ref: "#/$defs/RenderNode"
                                }
                            }, {
                                type: "null"
                            }]
                    },
                    Props: {
                        type: "object",
                        properties: {},
                        additionalProperties: {
                            anyOf: [{
                                    type: "string"
                                }, {
                                    type: "number"
                                }, {
                                    type: "boolean",
                                    "enum": [false]
                                }, {
                                    type: "boolean",
                                    "enum": [true]
                                }, {
                                    type: "object",
                                    additionalProperties: true
                                }, {
                                    type: "array",
                                    items: true
                                }, {
                                    asCell: true
                                }, {
                                    asStream: true
                                }, {
                                    type: "null"
                                }]
                        }
                    }
                }
            } as const satisfies __ctHelpers.JSONSchema, ({ element: charm, params: {} }) => (<li>{charm.name}</li>)), {})}
        </ul>
      </div>),
    };
}, false as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        $NAME: {
            type: "string",
            asOpaque: true
        },
        $UI: {
            $ref: "#/$defs/JSXElement"
        }
    },
    required: ["$NAME", "$UI"],
    $defs: {
        JSXElement: {
            anyOf: [{
                    $ref: "#/$defs/VNode"
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
                    $ref: "#/$defs/VNode"
                }
            },
            required: ["$UI"]
        },
        VNode: {
            type: "object",
            properties: {
                type: {
                    type: "string",
                    "enum": ["vnode"]
                },
                name: {
                    type: "string"
                },
                props: {
                    $ref: "#/$defs/Props"
                },
                children: {
                    $ref: "#/$defs/RenderNode"
                },
                $UI: {
                    $ref: "#/$defs/VNode"
                }
            },
            required: ["type", "name", "props"]
        },
        RenderNode: {
            anyOf: [{
                    type: "string"
                }, {
                    type: "number"
                }, {
                    type: "boolean",
                    "enum": [false]
                }, {
                    type: "boolean",
                    "enum": [true]
                }, {
                    $ref: "#/$defs/VNode"
                }, {
                    type: "object",
                    properties: {}
                }, {
                    $ref: "#/$defs/UIRenderable",
                    asOpaque: true
                }, {
                    type: "object",
                    properties: {}
                }, {
                    type: "array",
                    items: {
                        $ref: "#/$defs/RenderNode"
                    }
                }, {
                    type: "null"
                }]
        },
        Props: {
            type: "object",
            properties: {},
            additionalProperties: {
                anyOf: [{
                        type: "string"
                    }, {
                        type: "number"
                    }, {
                        type: "boolean",
                        "enum": [false]
                    }, {
                        type: "boolean",
                        "enum": [true]
                    }, {
                        type: "object",
                        additionalProperties: true
                    }, {
                        type: "array",
                        items: true
                    }, {
                        asCell: true
                    }, {
                        asStream: true
                    }, {
                        type: "null"
                    }]
            }
        }
    }
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
