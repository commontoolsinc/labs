import * as __ctHelpers from "commontools";
/**
 * Test: Actions closing over SELF
 *
 * This tests that actions defined inside a pattern body can close over
 * the `self` variable (from SELF symbol) and access its properties.
 */
import { action, NAME, pattern, SELF, UI, type VNode, Writable } from "commontools";
interface TestOutput {
    [NAME]: string;
    [UI]: VNode;
    title: string;
    count: number;
}
export default pattern(({ title, [SELF]: self }) => {
    const count = Writable.of(0, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    // Action closing over `self` - should work
    const showSelf = __ctHelpers.handler({
        type: "object",
        properties: {},
        additionalProperties: false
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "object",
        properties: {
            self: {
                type: "object",
                properties: {
                    title: {
                        type: "string",
                        asOpaque: true
                    }
                },
                required: ["title"]
            }
        },
        required: ["self"]
    } as const satisfies __ctHelpers.JSONSchema, (_, { self }) => {
        console.log("self.title:", self.title);
    })({
        self: {
            title: self.title
        }
    });
    // Action closing over both `self` and `count`
    const incrementWithSelf = __ctHelpers.handler({
        type: "object",
        properties: {},
        additionalProperties: false
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "object",
        properties: {
            self: {
                $ref: "#/$defs/TestOutput",
                asOpaque: true
            },
            count: {
                type: "number",
                asCell: true
            }
        },
        required: ["self", "count"],
        $defs: {
            TestOutput: {
                type: "object",
                properties: {
                    title: {
                        type: "string"
                    },
                    count: {
                        type: "number"
                    },
                    $NAME: {
                        type: "string"
                    },
                    $UI: {
                        $ref: "#/$defs/VNode"
                    }
                },
                required: ["title", "count", "$NAME", "$UI"]
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
            UIRenderable: {
                type: "object",
                properties: {
                    $UI: {
                        $ref: "#/$defs/VNode"
                    }
                },
                required: ["$UI"]
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
    } as const satisfies __ctHelpers.JSONSchema, (_, { self, count }) => {
        console.log("self:", self);
        count.set(count.get() + 1);
    })({
        self: self,
        count: count
    });
    return {
        [NAME]: "Action SELF Test",
        [UI]: (<div>
          <ct-button onClick={showSelf}>Show Self</ct-button>
          <ct-button onClick={incrementWithSelf}>Increment with Self</ct-button>
        </div>),
        title,
        count,
    };
}, {
    type: "object",
    properties: {
        title: {
            type: "string"
        }
    }
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        title: {
            type: "string"
        },
        count: {
            type: "number"
        },
        $NAME: {
            type: "string"
        },
        $UI: {
            $ref: "#/$defs/VNode"
        }
    },
    required: ["title", "count", "$NAME", "$UI"],
    $defs: {
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
        UIRenderable: {
            type: "object",
            properties: {
                $UI: {
                    $ref: "#/$defs/VNode"
                }
            },
            required: ["$UI"]
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
