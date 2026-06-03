function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Cell, handler, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const __cfLift_1 = __cfHelpers.lift<{
    castVote: __cfHelpers.HandlerFactory<{ votes: __cfHelpers.Cell<VoteEvent[]>; }, unknown>;
    state: {
        votes: VoteEvent[];
    };
}, import("commonfabric").Stream<unknown>>({
    type: "object",
    properties: {
        castVote: {
            type: "object",
            properties: {
                type: {
                    "enum": ["ref", "javascript", "pattern", "raw", "isolated", "passthrough"]
                },
                defaultScope: {
                    $ref: "#/$defs/CellScope"
                },
                "with": {
                    asCell: ["stream"]
                }
            },
            required: ["type", "with"]
        },
        state: {
            type: "object",
            properties: {
                votes: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/VoteEvent"
                    }
                }
            },
            required: ["votes"]
        }
    },
    required: ["castVote", "state"],
    $defs: {
        VoteEvent: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                step: {
                    "enum": ["single", "double"]
                }
            },
            required: ["id", "step"]
        },
        CellScope: {
            "enum": ["space", "user", "session"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, true as const satisfies __cfHelpers.JSONSchema, ({ castVote, state }) => castVote({ votes: state.votes }).for({ stream: "boundCastVote" }));
const __cfHandler_1 = __cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        boundCastVote: {
            type: "unknown",
            asCell: ["stream"]
        },
        item: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                }
            },
            required: ["id"]
        }
    },
    required: ["boundCastVote", "item"]
} as const satisfies __cfHelpers.JSONSchema, (__cf_handler_event, { boundCastVote, item }) => boundCastVote.send({
    id: item.id,
    step: "single",
}));
interface Item {
    id: string;
    label: string;
}
interface VoteEvent {
    id: string;
    step: "single" | "double";
}
interface State {
    items: Item[];
    canVote: boolean;
    votes: VoteEvent[];
}
const castVote = handler({
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        votes: {
            type: "array",
            items: {
                $ref: "#/$defs/VoteEvent"
            },
            asCell: ["cell"]
        }
    },
    required: ["votes"],
    $defs: {
        VoteEvent: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                step: {
                    "enum": ["single", "double"]
                }
            },
            required: ["id", "step"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, (_event, { votes }) => {
    votes.set([
        ...votes.get(),
        { id: "module", step: "single" },
    ]);
});
// FIXTURE: map-conditional-inline-handler-send
// Verifies: inline onClick handlers inside conditional JSX branches retain
// imperative handler semantics when nested in reactive map callbacks.
//   onClick={() => boundCastVote.send(...)} → bare handler callback body
//   not lift(...)(...boundCastVote.send(...))
// Context: The conditional branch makes expression rewriting recurse into the
// handler subtree; the authored handler arrow must be treated as safe context.
export default pattern((state) => {
    const boundCastVote = __cfLift_1({
        castVote: castVote,
        state: {
            votes: state.key("votes")
        }
    }).for({ stream: "boundCastVote" }, true);
    return {
        [UI]: (<div>
        {state.key("items").mapWithPattern(__cfHelpers.pattern(__cf_pattern_input => {
                const item = __cf_pattern_input.key("element");
                const state = __cf_pattern_input.key("params", "state");
                const boundCastVote = __cf_pattern_input.key("params", "boundCastVote");
                return (<div>
              {__cfHelpers.when({
                    type: "boolean"
                } as const satisfies __cfHelpers.JSONSchema, {
                    anyOf: [{}, {
                            type: "object",
                            properties: {}
                        }]
                } as const satisfies __cfHelpers.JSONSchema, {
                    anyOf: [{
                            type: "boolean"
                        }, {}, {
                            type: "object",
                            properties: {}
                        }]
                } as const satisfies __cfHelpers.JSONSchema, state.key("canVote"), <button type="button" onClick={__cfHandler_1({
                    boundCastVote: boundCastVote,
                    item: {
                        id: item.key("id")
                    }
                })}>
                  {item.key("label")}
                </button>)}
            </div>);
            }, {
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Item"
                    },
                    params: {
                        type: "object",
                        properties: {
                            state: {
                                type: "object",
                                properties: {
                                    canVote: {
                                        type: "boolean"
                                    }
                                },
                                required: ["canVote"]
                            },
                            boundCastVote: {
                                type: "unknown",
                                asCell: ["stream"]
                            }
                        },
                        required: ["state", "boundCastVote"]
                    }
                },
                required: ["element", "params"],
                $defs: {
                    Item: {
                        type: "object",
                        properties: {
                            id: {
                                type: "string"
                            },
                            label: {
                                type: "string"
                            }
                        },
                        required: ["id", "label"]
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
            } as const satisfies __cfHelpers.JSONSchema), {
                state: {
                    canVote: state.key("canVote")
                },
                boundCastVote: boundCastVote
            })}
      </div>),
    };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            }
        },
        canVote: {
            type: "boolean"
        },
        votes: {
            type: "array",
            items: {
                $ref: "#/$defs/VoteEvent"
            }
        }
    },
    required: ["items", "canVote", "votes"],
    $defs: {
        VoteEvent: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                step: {
                    "enum": ["single", "double"]
                }
            },
            required: ["id", "step"]
        },
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                label: {
                    type: "string"
                }
            },
            required: ["id", "label"]
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
