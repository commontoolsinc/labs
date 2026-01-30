import * as __ctHelpers from "commontools";
/**
 * Test case for unless() with a reactive array map as the fallback.
 *
 * unless(condition, fallback) returns condition if truthy, else fallback.
 * When fallback is items.map(...), the map gets transformed to mapWithPattern.
 * Schema injection needs to know the type of the mapWithPattern result.
 */
import { Cell, Default, pattern, UI } from "commontools";
interface Item {
    label: string;
}
interface PatternInput {
    customContent: Cell<any>;
    items: Cell<Default<Item[], [
    ]>>;
}
export default pattern(({ customContent, items }) => {
    return {
        [UI]: (<div>
        {/* unless(condition, fallback) where fallback is a reactive map */}
        {__ctHelpers.unless({
            asCell: true
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "array",
            items: {
                $ref: "#/$defs/UIRenderable"
            },
            asOpaque: true,
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
                            type: "string"
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
                            type: "boolean"
                        }, {}, {
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
                                type: "boolean"
                            }, {
                                type: "object",
                                additionalProperties: true
                            }, {
                                type: "array",
                                items: true
                            }, {}, {
                                type: "null"
                            }]
                    }
                }
            }
        } as const satisfies __ctHelpers.JSONSchema, {
            asCell: true
        } as const satisfies __ctHelpers.JSONSchema, customContent, items.mapWithPattern(__ctHelpers.recipe({
            type: "object",
            properties: {
                element: {
                    $ref: "#/$defs/Item"
                },
                params: {
                    type: "object",
                    properties: {}
                }
            },
            required: ["element", "params"],
            $defs: {
                Item: {
                    type: "object",
                    properties: {
                        label: {
                            type: "string"
                        }
                    },
                    required: ["label"]
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
        } as const satisfies __ctHelpers.JSONSchema, ({ element: item, params: {} }) => <li>{item.label}</li>), {}))}
      </div>),
    };
}, {
    type: "object",
    properties: {
        customContent: {
            asCell: true
        },
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            "default": [],
            asCell: true
        }
    },
    required: ["customContent", "items"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                label: {
                    type: "string"
                }
            },
            required: ["label"]
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
