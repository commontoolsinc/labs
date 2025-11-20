import * as __ctHelpers from "commontools";
import { Cell, recipe, UI } from "commontools";
declare global {
    interface MouseEvent {
        detail: number;
    }
}
interface State {
    metrics: Cell<number>;
    user?: {
        clicks: Cell<number>;
    };
}
export default recipe({
    type: "object",
    properties: {
        metrics: {
            type: "number",
            asCell: true
        },
        user: {
            type: "object",
            properties: {
                clicks: {
                    type: "number",
                    asCell: true
                }
            },
            required: ["clicks"]
        }
    },
    required: ["metrics"]
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
                    enum: ["vnode"]
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
                    enum: ["vnode"]
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
                    enum: [false]
                }, {
                    type: "boolean",
                    enum: [true]
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
                        enum: [false]
                    }, {
                        type: "boolean",
                        enum: [true]
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
    return {
        [UI]: (<button type="button" onClick={__ctHelpers.handler({
            type: "object",
            properties: {
                detail: true
            },
            required: ["detail"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        user: {
                            type: "object",
                            properties: {
                                clicks: {
                                    type: "number",
                                    asCell: true
                                }
                            },
                            required: ["clicks"]
                        },
                        metrics: {
                            type: "number",
                            asCell: true
                        }
                    },
                    required: ["metrics"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, (event, { state }) => state.user?.clicks.set(event.detail + state.metrics.get()))({
            state: {
                user: {
                    clicks: state.user?.clicks
                },
                metrics: state.metrics
            }
        })}>
        Track
      </button>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
