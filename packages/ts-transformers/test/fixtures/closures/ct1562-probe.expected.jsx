function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
// FIXTURE: ct1562-probe
// CT-1562 instrumented investigation probe (Default<[]> variant).
//
// Same shape as the failing fixture (with Default<[]>) but the derive
// callback also calls `inspectRooms` — a module-scope helper — so we
// can observe what `rooms` actually is at runtime when the schema has
// the anyOf split (`{ type: "array", items: false }` vs
// `{ items: { $ref: ... } }`).
//
// When deployed via `cf piece new <this>.tsx` and applied, the probe
// prints:
//   CT1562_PROBE: { isArray: false, ctor: "Object", keys: ["0","1"],
//                   hasMap: false, mapError: "TypeError: r.map ..." }
// — i.e., `rooms` arrives as a plain object with numeric keys, not an
// array. That's the proximate cause of the `rooms.map is not a function`
// crash in Berni's report.
//
// Kept committed because the probe scaffold (module-scope helper +
// derived value-site derive) is useful for re-investigating any other
// schema-traversal merge bugs. Allowed to bit-rot per the diagnostics
// convention (see test/diagnostics/README.md).
// See packages/ts-transformers/docs/ct1562-investigation.md.
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
// Module-scope helper — runs inside the derive callback after the
// transformer lowers the value-site expression.
function inspectRooms(rooms: unknown): string {
    // deno-lint-ignore no-explicit-any
    const r: any = rooms;
    const info: Record<string, unknown> = {
        type: typeof r,
        isArray: Array.isArray(r),
        ctor: r?.constructor?.name,
        keys: r && typeof r === "object"
            ? Object.keys(r).slice(0, 10)
            : undefined,
        hasGet: typeof r?.get === "function",
        hasMap: typeof r?.map === "function",
        len: r?.length,
        proto: r ? Object.getPrototypeOf(r)?.constructor?.name : undefined,
    };
    try {
        const mapped = r.map((room: {
            name?: string;
            messages?: unknown[];
        }) => `${room?.name}: ${room?.messages?.length}`);
        info.mappedOk = true;
        info.mapped = mapped;
    }
    catch (e) {
        info.mappedOk = false;
        info.mapError = String(e);
    }
    console.log("CT1562_PROBE:", JSON.stringify(info));
    return "probe:" + JSON.stringify(info);
}
__cfHardenFn(inspectRooms);
export default pattern((__cf_pattern_input) => {
    const conversation = __cf_pattern_input.key("conversation");
    const rooms = conversation.key("rooms");
    // Drive a derive over `rooms` but use only the probe helper — no
    // direct .map().join() reference here.
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
    } as const satisfies __cfHelpers.JSONSchema, { rooms: rooms }, ({ rooms }) => inspectRooms(rooms) + " | len=" + rooms.length).for("roomSummaryText", true);
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
