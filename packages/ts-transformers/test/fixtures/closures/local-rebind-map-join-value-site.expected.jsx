function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Default, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Room {
    name: string;
    messages: string[] | Default<[
    ]>;
}
interface Conversation {
    rooms: Room[] | Default<[
    ]>;
}
interface Input {
    conversation: Conversation;
}
// FIXTURE: local-rebind-map-join-value-site
// Verifies (CT-1562): when a local rebinds a reactive property
//   (`const rooms = conversation.rooms`) and is used both inside JSX
//   (`rooms.map(...)` → mapWithPattern) and in a non-JSX value-site
//   expression (`rooms.map(...).join(...)` → derive), the value-site
//   derive must receive the unwrapped array rather than the key-cell.
// Bug: today the derive callback is invoked with `rooms` still being a
//   cell (key-cell from `.key("rooms")`), so `rooms.map(...)` throws
//   `TypeError: rooms.map is not a function` at runtime.
export default pattern((__cf_pattern_input) => {
    const conversation = __cf_pattern_input.key("conversation");
    const rooms = conversation.key("rooms");
    const roomSummaryText = __cfHelpers.derive({
        type: "object",
        properties: {
            rooms: {
                anyOf: [{
                        type: "array",
                        items: {
                            $ref: "#/$defs/Room"
                        }
                    }, {
                        type: "array",
                        items: false
                    }]
            }
        },
        required: ["rooms"],
        $defs: {
            Room: {
                type: "object",
                properties: {
                    name: {
                        type: "string"
                    },
                    messages: {
                        type: "array",
                        items: {
                            type: "string"
                        },
                        "default": []
                    }
                },
                required: ["name", "messages"]
            }
        }
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, { rooms: rooms }, ({ rooms }) => rooms
        .map((room) => `${room.name}: ${room.messages.length}`)
        .join("\n")).for("roomSummaryText", true);
    return {
        [UI]: (<div>
        {rooms.mapWithPattern(__cfHelpers.pattern(__cf_pattern_input => {
            const room = __cf_pattern_input.key("element");
            return <span>{room.key("name")}</span>;
        }, {
            type: "object",
            properties: {
                element: {
                    $ref: "#/$defs/Room"
                }
            },
            required: ["element"],
            $defs: {
                Room: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string"
                        },
                        messages: {
                            type: "array",
                            items: {
                                type: "string"
                            },
                            "default": []
                        }
                    },
                    required: ["name", "messages"]
                }
            }
        } as const satisfies __cfHelpers.JSONSchema, {
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
        } as const satisfies __cfHelpers.JSONSchema), {})}
        <p>{roomSummaryText}</p>
      </div>),
        roomSummaryText,
    };
}, {
    type: "object",
    properties: {
        conversation: {
            $ref: "#/$defs/Conversation"
        }
    },
    required: ["conversation"],
    $defs: {
        Conversation: {
            type: "object",
            properties: {
                rooms: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Room"
                    },
                    "default": []
                }
            },
            required: ["rooms"]
        },
        Room: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                messages: {
                    type: "array",
                    items: {
                        type: "string"
                    },
                    "default": []
                }
            },
            required: ["name", "messages"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "#/$defs/JSXElement"
        },
        roomSummaryText: {
            type: "string"
        }
    },
    required: ["$UI", "roomSummaryText"],
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
