import * as __ctHelpers from "commontools";
import { mapByKey, recipe, UI } from "commontools";
interface State {
    items: {
        id: number;
        name: string;
    }[];
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
        }
    },
    required: ["items"]
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
    // No captures - should still transform to ensure element becomes opaque
    const names = __ctHelpers.mapByKey(state.items, "id", __ctHelpers.recipe({
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
                properties: {}
            }
        },
        required: ["element", "params"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "string",
        asOpaque: true
    } as const satisfies __ctHelpers.JSONSchema, ({ element: item, params: {} }) => item.name), {});
    return {
        [UI]: <div>Names: {__ctHelpers.derive({
            type: "object",
            properties: {
                names: {
                    type: "array",
                    items: {
                        type: "string"
                    },
                    asOpaque: true
                }
            },
            required: ["names"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { names: names }, ({ names }) => JSON.stringify(names))}</div>,
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
