import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
interface Reaction {
    emoji: string;
    userNames: string[];
}
interface Message {
    id: string;
    reactions?: Reaction[];
}
interface Input {
    messages: Message[];
}
// FIXTURE: map-inline-fallback-receivers
// Verifies: inline fallback array-method receivers are transformed structurally
//   (msg.reactions ?? []).map(fn) → derive(...).mapWithPattern(pattern(...), { msg: { id: ... } })
//   (msg.reactions || []).map(fn) → derive(...).mapWithPattern(pattern(...), { msg: { id: ... } })
// Context: Nested map — outer maps messages, inner fallback receivers capture msg.id and message-local reaction data
export default pattern((__ct_pattern_input) => {
    const messages = __ct_pattern_input.key("messages");
    return {
        [UI]: (<div>
        {messages.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                const msg = __ct_pattern_input.key("element");
                return (<section>
            {(msg.key("reactions") ?? []).mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                        const reaction = __ct_pattern_input.key("element");
                        const msg = __ct_pattern_input.key("params", "msg");
                        return (<button type="button" data-msg-id={msg.key("id")}>
                {reaction.key("emoji")}
              </button>);
                    }, {
                        type: "object",
                        properties: {
                            element: {
                                $ref: "#/$defs/Reaction"
                            },
                            params: {
                                type: "object",
                                properties: {
                                    msg: {
                                        type: "object",
                                        properties: {
                                            id: {
                                                type: "string"
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
                                    },
                                    userNames: {
                                        type: "array",
                                        items: {
                                            type: "string"
                                        }
                                    }
                                },
                                required: ["emoji", "userNames"]
                            }
                        }
                    } as const satisfies __ctHelpers.JSONSchema, {
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
                    } as const satisfies __ctHelpers.JSONSchema), {
                        msg: {
                            id: msg.key("id")
                        }
                    })}
            {(msg.key("reactions") || []).mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                        const reaction = __ct_pattern_input.key("element");
                        const msg = __ct_pattern_input.key("params", "msg");
                        return (<span>
                {msg.key("id")}:{reaction.key("userNames", "length")}
              </span>);
                    }, {
                        type: "object",
                        properties: {
                            element: {
                                $ref: "#/$defs/Reaction"
                            },
                            params: {
                                type: "object",
                                properties: {
                                    msg: {
                                        type: "object",
                                        properties: {
                                            id: {
                                                type: "string"
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
                                    },
                                    userNames: {
                                        type: "array",
                                        items: {
                                            type: "string"
                                        }
                                    }
                                },
                                required: ["emoji", "userNames"]
                            }
                        }
                    } as const satisfies __ctHelpers.JSONSchema, {
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
                    } as const satisfies __ctHelpers.JSONSchema), {
                        msg: {
                            id: msg.key("id")
                        }
                    })}
          </section>);
            }, {
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Message"
                    }
                },
                required: ["element"],
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
                            },
                            userNames: {
                                type: "array",
                                items: {
                                    type: "string"
                                }
                            }
                        },
                        required: ["emoji", "userNames"]
                    }
                }
            } as const satisfies __ctHelpers.JSONSchema, {
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
                },
                userNames: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                }
            },
            required: ["emoji", "userNames"]
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
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
