import * as __ctHelpers from "commontools";
import { computed, pattern, UI } from "commontools";
interface Reaction {
    emoji: string;
}
interface Message {
    id: string;
    reactions?: Reaction[];
}
interface Input {
    messages: Message[];
}
export default pattern((__ct_pattern_input) => {
    const messages = __ct_pattern_input.key("messages");
    return {
        [UI]: (<div>
        {messages.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                const msg = __ct_pattern_input.key("element");
                const messageReactions = __ctHelpers.derive({
                    type: "object",
                    properties: {
                        msg: {
                            type: "object",
                            properties: {
                                reactions: {
                                    anyOf: [{
                                            type: "undefined"
                                        }, {
                                            anyOf: [{
                                                    type: "undefined"
                                                }, {
                                                    type: "array",
                                                    items: {
                                                        $ref: "#/$defs/Reaction"
                                                    }
                                                }],
                                            asOpaque: true
                                        }]
                                }
                            }
                        }
                    },
                    required: ["msg"],
                    $defs: {
                        Reaction: {
                            type: "object",
                            properties: {
                                emoji: {
                                    type: "string"
                                }
                            },
                            required: ["emoji"]
                        }
                    }
                } as const satisfies __ctHelpers.JSONSchema, {
                    anyOf: [{
                            anyOf: [{
                                    type: "undefined"
                                }, {
                                    type: "array",
                                    items: {
                                        $ref: "#/$defs/Reaction"
                                    }
                                }],
                            asOpaque: true
                        }, {
                            type: "array",
                            items: false
                        }],
                    $defs: {
                        Reaction: {
                            type: "object",
                            properties: {
                                emoji: {
                                    type: "string"
                                }
                            },
                            required: ["emoji"]
                        }
                    }
                } as const satisfies __ctHelpers.JSONSchema, { msg: {
                        reactions: msg.key("reactions")
                    } }, ({ msg }) => (msg.reactions) || []);
                return (<div>
              {messageReactions.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                        const reaction = __ct_pattern_input.key("element");
                        const msg = __ct_pattern_input.key("params", "msg");
                        return (<button type="button" data-msg-id={msg.key("id")}>
                  {reaction.key("emoji")}
                </button>);
                    }, {
                        type: "object",
                        properties: {
                            element: {
                                anyOf: [{
                                        anyOf: [{
                                                type: "undefined"
                                            }, {
                                                type: "array",
                                                items: {
                                                    $ref: "#/$defs/Reaction"
                                                }
                                            }],
                                        asOpaque: true
                                    }, {
                                        type: "array",
                                        items: false
                                    }]
                            },
                            params: {
                                type: "object",
                                properties: {
                                    msg: {
                                        type: "object",
                                        properties: {
                                            id: {
                                                type: "string",
                                                asOpaque: true
                                            }
                                        },
                                        required: ["id"]
                                    }
                                },
                                required: ["msg"]
                            }
                        },
                        required: ["element", "params"],
                        $defs: {
                            Reaction: {
                                type: "object",
                                properties: {
                                    emoji: {
                                        type: "string"
                                    }
                                },
                                required: ["emoji"]
                            }
                        }
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
                        msg: {
                            id: msg.key("id")
                        }
                    })}
            </div>);
            }, {
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Message"
                    },
                    params: {
                        type: "object",
                        properties: {}
                    }
                },
                required: ["element", "params"],
                $defs: {
                    Message: {
                        type: "object",
                        properties: {
                            id: {
                                type: "string"
                            },
                            reactions: {
                                type: "array",
                                items: {
                                    $ref: "#/$defs/Reaction"
                                }
                            }
                        },
                        required: ["id"]
                    },
                    Reaction: {
                        type: "object",
                        properties: {
                            emoji: {
                                type: "string"
                            }
                        },
                        required: ["emoji"]
                    }
                }
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
            } as const satisfies __ctHelpers.JSONSchema), {})}
      </div>),
    };
}, {
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
                id: {
                    type: "string"
                },
                reactions: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Reaction"
                    }
                }
            },
            required: ["id"]
        },
        Reaction: {
            type: "object",
            properties: {
                emoji: {
                    type: "string"
                }
            },
            required: ["emoji"]
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
