function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { derive, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
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
// FIXTURE: derive-map-union-return
// Verifies: derive returning a union type (string | null) with nested .map() infers the correct output schema
//   derive(state.messages, fn) → derive(schema, anyOf[string, null], state.key("messages"), fn)
//   inner .map() inside derive callback → NOT transformed (plain array after unwrap)
// Context: previously caused schema to fall back to `true` when the callback became synthetic
export default pattern((state) => {
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
    } as const satisfies __cfHelpers.JSONSchema, {
        anyOf: [{
                type: "string"
            }, {
                type: "null"
            }]
    } as const satisfies __cfHelpers.JSONSchema, state.key("messages"), (messages) => {
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
