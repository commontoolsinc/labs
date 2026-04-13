function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { handler, ifElse, lift, pattern, UI, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const moduleHasSettings = lift({
    type: "object",
    properties: {
        piece: {
            type: "object",
            properties: {
                settingsUI: {
                    type: "string"
                }
            }
        }
    },
    required: ["piece"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, ({ piece }: {
    piece: {
        settingsUI?: string;
    };
}) => !!piece?.settingsUI);
const selectMessage = handler({
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        selectedId: {
            type: "string",
            asCell: ["cell"]
        },
        msgId: {
            type: "string"
        }
    },
    required: ["selectedId", "msgId"]
} as const satisfies __cfHelpers.JSONSchema, (_event, { selectedId, msgId }) => {
    selectedId.set(msgId);
});
interface Entry {
    piece: {
        settingsUI?: string;
    };
}
interface Message {
    id: string;
    type: "chat" | "system";
}
// FIXTURE: ifelse-factory-boundaries
// Verifies: authored ifElse keeps captured property access inside factory boundaries
//   moduleHasSettings({ piece: entry.piece }) → piece capture stays structural inside lift() call
//   selectMessage({ selectedId, msgId: msg.id }) → msg.id stays structural inside handler call branch
export default pattern((__cf_pattern_input) => {
    const entries = __cf_pattern_input.key("entries");
    const messages = __cf_pattern_input.key("messages");
    const selectedId = Writable.of("", {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema);
    return {
        [UI]: (<div>
          {entries.mapWithPattern(__cfHelpers.pattern(__cf_pattern_input => {
                const entry = __cf_pattern_input.key("element");
                return ifElse({
                    type: "boolean"
                } as const satisfies __cfHelpers.JSONSchema, {
                    anyOf: [{}, {
                            type: "object",
                            properties: {}
                        }]
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "null"
                } as const satisfies __cfHelpers.JSONSchema, {
                    anyOf: [{
                            type: "null"
                        }, {}]
                } as const satisfies __cfHelpers.JSONSchema, moduleHasSettings({ piece: entry.key("piece") }), <span>settings</span>, null);
            }, {
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Entry"
                    }
                },
                required: ["element"],
                $defs: {
                    Entry: {
                        type: "object",
                        properties: {
                            piece: {
                                type: "object",
                                properties: {
                                    settingsUI: {
                                        type: "string"
                                    }
                                }
                            }
                        },
                        required: ["piece"]
                    }
                }
            } as const satisfies __cfHelpers.JSONSchema, {
                anyOf: [{
                        type: "null"
                    }, {
                        $ref: "https://commonfabric.org/schemas/vnode.json"
                    }, {
                        $ref: "#/$defs/UIRenderable"
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
            } as const satisfies __cfHelpers.JSONSchema), {})}
          {messages.mapWithPattern(__cfHelpers.pattern(__cf_pattern_input => {
                const msg = __cf_pattern_input.key("element");
                const selectedId = __cf_pattern_input.key("params", "selectedId");
                return ifElse({
                    type: "boolean"
                } as const satisfies __cfHelpers.JSONSchema, {
                    anyOf: [{}, {
                            type: "object",
                            properties: {}
                        }]
                } as const satisfies __cfHelpers.JSONSchema, {
                    anyOf: [{}, {
                            type: "object",
                            properties: {}
                        }]
                } as const satisfies __cfHelpers.JSONSchema, {} as const satisfies __cfHelpers.JSONSchema, __cfHelpers.derive({
                    type: "object",
                    properties: {
                        msg: {
                            type: "object",
                            properties: {
                                type: {
                                    type: "string"
                                }
                            },
                            required: ["type"]
                        }
                    },
                    required: ["msg"]
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "boolean"
                } as const satisfies __cfHelpers.JSONSchema, { msg: {
                        type: msg.key("type")
                    } }, ({ msg }) => msg.type === "system"), <span>{msg.key("id")}</span>, <button type="button" onClick={selectMessage({ selectedId, msgId: msg.key("id") })}>
                open
              </button>);
            }, {
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Message"
                    },
                    params: {
                        type: "object",
                        properties: {
                            selectedId: {
                                type: "string",
                                asCell: ["cell"]
                            }
                        },
                        required: ["selectedId"]
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
                            type: {
                                "enum": ["chat", "system"]
                            }
                        },
                        required: ["id", "type"]
                    }
                }
            } as const satisfies __cfHelpers.JSONSchema, {
                anyOf: [{
                        $ref: "https://commonfabric.org/schemas/vnode.json"
                    }, {
                        $ref: "#/$defs/UIRenderable"
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
            } as const satisfies __cfHelpers.JSONSchema), {
                selectedId: selectedId
            })}
        </div>),
    };
}, {
    type: "object",
    properties: {
        entries: {
            type: "array",
            items: {
                $ref: "#/$defs/Entry"
            }
        },
        messages: {
            type: "array",
            items: {
                $ref: "#/$defs/Message"
            }
        }
    },
    required: ["entries", "messages"],
    $defs: {
        Message: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                type: {
                    "enum": ["chat", "system"]
                }
            },
            required: ["id", "type"]
        },
        Entry: {
            type: "object",
            properties: {
                piece: {
                    type: "object",
                    properties: {
                        settingsUI: {
                            type: "string"
                        }
                    }
                }
            },
            required: ["piece"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
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
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
