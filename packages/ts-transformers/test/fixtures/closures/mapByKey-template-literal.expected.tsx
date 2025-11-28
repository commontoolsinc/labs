import * as __ctHelpers from "commontools";
import { mapByKey, recipe, UI } from "commontools";
interface State {
    items: {
        id: number;
        name: string;
    }[];
    prefix: string;
}
export default recipe({
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    id: {
                        type: "number"
                    },
                    name: {
                        type: "string"
                    }
                },
                required: ["id", "name"]
            }
        },
        prefix: {
            type: "string"
        }
    },
    required: ["items", "prefix"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "#/$defs/Element"
        }
    },
    required: ["$UI"],
    $defs: {
        Element: {
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
                    type: "array",
                    items: {
                        $ref: "#/$defs/RenderNode"
                    }
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
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    // Template literal with captured value - should be wrapped with str tag
    const formatted = __ctHelpers.mapByKey(state.items, "id", __ctHelpers.recipe({
        type: "object",
        properties: {
            element: {
                type: "object",
                properties: {
                    id: {
                        type: "number"
                    },
                    name: {
                        type: "string"
                    }
                },
                required: ["id", "name"]
            },
            params: {
                type: "object",
                properties: {
                    state: {
                        type: "object",
                        properties: {
                            prefix: {
                                type: "string",
                                asOpaque: true
                            }
                        },
                        required: ["prefix"]
                    }
                },
                required: ["state"]
            }
        },
        required: ["element", "params"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "object",
        properties: {
            id: {
                type: "number",
                asOpaque: true
            },
            label: {
                type: "string"
            }
        },
        required: ["id", "label"]
    } as const satisfies __ctHelpers.JSONSchema, ({ element: item, params: { state } }) => ({
        id: item.id,
        label: __ctHelpers.str `${state.prefix}-${item.name}`,
    })), {
        state: {
            prefix: state.prefix
        }
    });
    return {
        [UI]: <div>Items: {__ctHelpers.derive({
            type: "object",
            properties: {
                formatted: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            id: {
                                type: "number",
                                asOpaque: true
                            },
                            label: {
                                type: "string"
                            }
                        },
                        required: ["id", "label"]
                    },
                    asOpaque: true
                }
            },
            required: ["formatted"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { formatted: formatted }, ({ formatted }) => JSON.stringify(formatted))}</div>,
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
