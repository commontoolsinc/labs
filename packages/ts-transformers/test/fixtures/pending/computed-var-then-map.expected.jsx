function __ctHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import * as __ctHelpers from "commontools";
/**
 * BUG REPRO: .map() after || [] or ?? [] fallback is not transformed to mapWithPattern
 *
 * ISSUE SUMMARY:
 * When an expression with a fallback (|| [] or ?? []) is followed by .map(),
 * the fallback gets transformed to a derive(), but the subsequent .map() is NOT
 * transformed to mapWithPattern. This causes runtime errors when the inner
 * callback accesses variables from outer scopes.
 *
 * STEPS TO REPRODUCE:
 * 1. Outer .map() on a reactive array: messages.map((msg) => ...)
 * 2. Inside, use fallback: (msg.reactions || []).map(...) or via computed variable
 * 3. Access outer variable in inner callback: ... msg.id ...
 *
 * EXPECTED:
 * - The .map() after fallback should be transformed to mapWithPattern
 * - msg.id should be captured and passed through params
 *
 * ACTUAL:
 * - The fallback (msg.reactions || []) becomes derive({ msg }, ({ msg }) => msg.reactions || [])
 * - But .map() on that derive result is NOT transformed to mapWithPattern
 * - Runtime error: "Cell with parent cell not found in current frame.
 *   Likely a closure that should have been transformed."
 *
 * ROOT CAUSE (in map-strategy.ts):
 * When checking if .map() needs transformation:
 * 1. isDeriveCall(target) - The target is the derive result IDENTIFIER, not a derive CALL
 * 2. isOpaqueRefType(targetType) - The type registry has the unwrapped type, not OpaqueRef<T>
 *
 * The type flow:
 * - derive(..., ({ msg }) => msg.reactions || []) returns OpaqueRef<Reaction[] | never[]>
 * - But the type registry stores the callback return type (Reaction[] | never[]), not OpaqueRef
 * - So isOpaqueRefType() fails and the .map() is not transformed
 *
 * WORKAROUND:
 * Use direct property access WITHOUT fallback:
 *   {msg.reactions.map((r) => ...)}  // Works - msg.reactions is OpaqueRef<Reaction[]>
 * Instead of:
 *   {(msg.reactions || []).map((r) => ...)}  // Fails - fallback breaks type detection
 *
 * This requires making the property non-optional in the interface.
 */
import { computed, pattern, UI } from "commontools";
interface Reaction {
    emoji: string;
    userNames: string[];
}
interface Message {
    id: string;
    author: string;
    content: string;
    reactions?: Reaction[]; // Optional property requiring fallback
}
interface Input {
    messages: Message[];
}
// FIXTURE: computed-var-then-map
// Verifies: KNOWN BUG — .map() after || [] fallback via computed variable is NOT transformed
//   computed(() => msg.reactions || []).map(fn) — the .map() should become mapWithPattern but doesn't
// Context: Pending fix. The derive result loses OpaqueRef type info, so map-strategy skips it.
export default pattern((__ct_pattern_input) => {
    const messages = __ct_pattern_input.key("messages");
    return {
        [UI]: (<div>
        {messages.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                const msg = __ct_pattern_input.key("element");
                // Method 1: computed variable with fallback - FAILS
                const messageReactions = __ctHelpers.derive({
                    type: "object",
                    properties: {
                        msg: {
                            $ref: "#/$defs/Message"
                        }
                    },
                    required: ["msg"],
                    $defs: {
                        Message: {
                            type: "object",
                            properties: {
                                id: {
                                    type: "string"
                                },
                                author: {
                                    type: "string"
                                },
                                content: {
                                    type: "string"
                                },
                                reactions: {
                                    type: "array",
                                    items: {
                                        $ref: "#/$defs/Reaction"
                                    }
                                }
                            },
                            required: ["id", "author", "content"]
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
                    type: "array",
                    items: {
                        $ref: "#/$defs/Reaction"
                    },
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
                } as const satisfies __ctHelpers.JSONSchema, { msg: msg }, ({ msg }) => (msg && msg.reactions) || []);
                return (<div>
              <p>{msg.key("content")}</p>
              <div>
                {/* BUG: This .map() is NOT transformed to mapWithPattern.
                        The derive result doesn't pass the OpaqueRef type check.
                        Accessing msg.id causes runtime error. */}
                {messageReactions.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                        const reaction = __ct_pattern_input.key("element");
                        const msg = __ct_pattern_input.key("params", "msg");
                        return (<button type="button" data-msg-id={msg.key("id")}>
                    {reaction.key("emoji")} ({reaction.key("userNames", "length")})
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
              </div>
            </div>);
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
                            author: {
                                type: "string"
                            },
                            content: {
                                type: "string"
                            },
                            reactions: {
                                type: "array",
                                items: {
                                    $ref: "#/$defs/Reaction"
                                }
                            }
                        },
                        required: ["id", "author", "content"]
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
                author: {
                    type: "string"
                },
                content: {
                    type: "string"
                },
                reactions: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Reaction"
                    }
                }
            },
            required: ["id", "author", "content"]
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
/**
 * NOTE: The following inline patterns also fail for the same reason:
 *
 * {(msg.reactions || []).map((r) => ...)}  // FAILS - || creates derive
 * {(msg.reactions ?? []).map((r) => ...)}  // FAILS - ?? creates derive
 *
 * Only direct property access works:
 * {msg.reactions.map((r) => ...)}  // WORKS - direct OpaqueRef property
 */
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
__ctHardenFn(h);
