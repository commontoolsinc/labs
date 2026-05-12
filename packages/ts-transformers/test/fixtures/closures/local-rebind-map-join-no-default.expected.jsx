function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Room {
    name: string;
    messages: string[];
}
interface Conversation {
    rooms: Room[];
}
interface Input {
    conversation: Conversation;
}
// FIXTURE: local-rebind-map-join-no-default
// Verifies: same shape as CT-1562's failing repro (local rebind +
//   value-site .map().join() + JSX .map() of the same local) BUT
//   without `Default<[]>` on the rooms field. This baseline succeeds
//   at runtime (cf piece apply → "alpha: 2\nbeta: 0"), proving the
//   transformer lowering itself is correct.
// Context: companion to `local-rebind-map-join-value-site` which adds
//   `Default<[]>` and crashes at runtime. The crash is triggered by
//   the `anyOf: [{ items: false }, { items: ref }]` schema shape that
//   `Default<[]>` produces, not by the rebind.
// See packages/ts-transformers/docs/ct1562-investigation.md.
export default pattern((__cf_pattern_input) => {
    const conversation = __cf_pattern_input.key("conversation");
    const rooms = conversation.key("rooms");
    const roomSummaryText = __cfHelpers.derive({
        type: "object",
        properties: {
            rooms: {
                type: "array",
                items: {
                    $ref: "#/$defs/Room"
                }
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
                        }
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
                            }
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
                    }
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
                    }
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
