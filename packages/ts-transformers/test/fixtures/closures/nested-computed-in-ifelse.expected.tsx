import * as __ctHelpers from "commontools";
/**
 * Regression test: computed() inside ifElse branch should not double-wrap .get()
 *
 * When a computed() callback is inside an ifElse branch, the OpaqueRefJSX
 * transformer's rewriteChildExpressions should NOT wrap expressions like
 * `toggle.get()` in an extra derive, since the computed callback is already
 * a safe reactive context.
 *
 * Bug: secondToggle.get() was returning CellImpl instead of boolean
 * Fix: Added isInsideSafeCallbackWrapper check in rewriteChildExpressions
 */
import { computed, ifElse, pattern, UI, Writable } from "commontools";
export default pattern(() => {
    const showOuter = Writable.of(false, {
        type: "boolean"
    } as const satisfies __ctHelpers.JSONSchema);
    const secondToggle = Writable.of(false, {
        type: "boolean"
    } as const satisfies __ctHelpers.JSONSchema);
    return {
        [UI]: (<div>
        {/* Case A: Top-level computed - always worked */}
        <div style={__ctHelpers.derive({
                type: "object",
                properties: {
                    secondToggle: {
                        type: "boolean",
                        asCell: true
                    }
                },
                required: ["secondToggle"]
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "object",
                properties: {
                    background: {
                        type: "string"
                    }
                },
                required: ["background"]
            } as const satisfies __ctHelpers.JSONSchema, { secondToggle: secondToggle }, ({ secondToggle }) => {
                const val = secondToggle.get();
                return { background: val ? "green" : "red" };
            })}>Case A</div>

        {/* Case B: Computed inside ifElse - this was the bug */}
        {ifElse({
                type: "boolean",
                asCell: true
            } as const satisfies __ctHelpers.JSONSchema, {
                anyOf: [{}, {
                        type: "object",
                        properties: {}
                    }]
            } as const satisfies __ctHelpers.JSONSchema, {
                anyOf: [{}, {
                        type: "object",
                        properties: {}
                    }]
            } as const satisfies __ctHelpers.JSONSchema, {
                $ref: "#/$defs/AnonymousType_1",
                $defs: {
                    AnonymousType_1: {
                        $ref: "#/$defs/UIRenderable",
                        asOpaque: true
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
            } as const satisfies __ctHelpers.JSONSchema, showOuter, <div style={__ctHelpers.derive({
                    type: "object",
                    properties: {
                        secondToggle: {
                            type: "boolean",
                            asCell: true
                        }
                    },
                    required: ["secondToggle"]
                } as const satisfies __ctHelpers.JSONSchema, {
                    type: "object",
                    properties: {
                        background: {
                            type: "string"
                        }
                    },
                    required: ["background"]
                } as const satisfies __ctHelpers.JSONSchema, { secondToggle: secondToggle }, ({ secondToggle }) => {
                    // This .get() should NOT be wrapped in extra derive
                    const val = secondToggle.get();
                    return { background: val ? "green" : "red" };
                })}>Case B</div>, <div>Hidden</div>)}
      </div>),
    };
}, {
    type: "object",
    properties: {},
    additionalProperties: false
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
