import * as __ctHelpers from "commontools";
import { derive, recipe, UI } from "commontools";
interface ContentPart {
    type: "text" | "image";
    text?: string;
    image?: string;
}
interface Message {
    role: "user" | "assistant";
    content: string | ContentPart[];
}
interface State {
    messages: Message[];
}
export default recipe({
    type: "object",
    properties: {
        messages: {
            type: "array",
            items: {
                $ref: "#/$defs/Message"
            }
        }
    },
    required: ["messages"],
    $defs: {
        Message: {
            type: "object",
            properties: {
                role: {
                    "enum": ["user", "assistant"]
                },
                content: {
                    anyOf: [{
                            type: "string"
                        }, {
                            type: "array",
                            items: {
                                $ref: "#/$defs/ContentPart"
                            }
                        }]
                }
            },
            required: ["role", "content"]
        },
        ContentPart: {
            type: "object",
            properties: {
                type: {
                    "enum": ["text", "image"]
                },
                text: {
                    type: "string"
                },
                image: {
                    type: "string"
                }
            },
            required: ["type"]
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
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    // This derive callback contains a nested map and returns string | null
    // The callback becomes synthetic during transformation, which previously
    // caused type inference to fail, resulting in a 'true' schema instead of
    // the correct union type schema.
    const latestMessage = derive({
        type: "array",
        items: {
            $ref: "#/$defs/Message"
        },
        $defs: {
            Message: {
                type: "object",
                properties: {
                    role: {
                        "enum": ["user", "assistant"]
                    },
                    content: {
                        anyOf: [{
                                type: "string"
                            }, {
                                type: "array",
                                items: {
                                    $ref: "#/$defs/ContentPart"
                                }
                            }]
                    }
                },
                required: ["role", "content"]
            },
            ContentPart: {
                type: "object",
                properties: {
                    type: {
                        "enum": ["text", "image"]
                    },
                    text: {
                        type: "string"
                    },
                    image: {
                        type: "string"
                    }
                },
                required: ["type"]
            }
        }
    } as const satisfies __ctHelpers.JSONSchema, {
        anyOf: [{
                type: "string"
            }, {
                type: "null"
            }]
    } as const satisfies __ctHelpers.JSONSchema, state.messages, (messages) => {
        if (!messages || messages.length === 0)
            return null;
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i]!;
            if (msg.role === "assistant") {
                // This map call inside the derive callback was the key issue
                const content = typeof msg.content === "string"
                    ? msg.content
                    : msg.content.map((part) => {
                        if (part.type === "text")
                            return part.text || "";
                        return "";
                    }).join("");
                return content;
            }
        }
        return null;
    });
    return {
        [UI]: (<div>
        <div>Latest: {latestMessage}</div>
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
