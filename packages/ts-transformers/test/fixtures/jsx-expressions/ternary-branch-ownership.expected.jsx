import * as __ctHelpers from "commontools";
import { computed, pattern, UI, Writable } from "commontools";
interface TagEvent {
    label: string;
}
interface Item {
    name: string;
    value: number;
}
type State = {
    user: {
        settings: {
            notifications: boolean;
        };
    };
    recentEvents: TagEvent[];
    items: Item[];
};
// FIXTURE: ternary-branch-ownership
// Verifies: ternary branches preserve the right ownership mode for lowered work
//   state.user.settings.notifications ? "enabled" : "disabled"
//     -> ifElse(...) with a boolean predicate schema after key(...) lowering
//   recentEvents.length === 0 ? <span>... : <div>{recentEvents.map(...)}</div>
//     -> single branch derive + recentEvents.mapWithPattern(...)
//   showList ? (() => { const itemCount = count + " items"; return <div>{sorted.map(...)}</div>; })() : ...
//     -> whole branch compute-wrapped, so sorted.map(...) stays plain JS
export default pattern((state) => {
    const showList = Writable.of(true, {
        type: "boolean"
    } as const satisfies __ctHelpers.JSONSchema);
    const sorted = __ctHelpers.derive({
        type: "object",
        properties: {
            state: {
                type: "object",
                properties: {
                    items: {
                        type: "array",
                        items: {
                            $ref: "#/$defs/Item"
                        }
                    }
                },
                required: ["items"]
            }
        },
        required: ["state"],
        $defs: {
            Item: {
                type: "object",
                properties: {
                    name: {
                        type: "string"
                    },
                    value: {
                        type: "number"
                    }
                },
                required: ["name", "value"]
            }
        }
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "array",
        items: {
            $ref: "#/$defs/Item"
        },
        $defs: {
            Item: {
                type: "object",
                properties: {
                    name: {
                        type: "string"
                    },
                    value: {
                        type: "number"
                    }
                },
                required: ["name", "value"]
            }
        }
    } as const satisfies __ctHelpers.JSONSchema, { state: {
            items: state.key("items")
        } }, ({ state }) => [...state.items].sort((a, b) => a.value - b.value));
    const count = __ctHelpers.derive({
        type: "object",
        properties: {
            state: {
                type: "object",
                properties: {
                    items: {
                        type: "object",
                        properties: {
                            length: {
                                type: "number"
                            }
                        },
                        required: ["length"]
                    }
                },
                required: ["items"]
            }
        },
        required: ["state"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, { state: {
            items: {
                length: state.key("items", "length")
            }
        } }, ({ state }) => state.items.length);
    return {
        [UI]: (<div>
        <p>{__ctHelpers.ifElse({
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            "enum": ["enabled", "disabled"]
        } as const satisfies __ctHelpers.JSONSchema, state.key("user", "settings", "notifications"), "enabled", "disabled")}</p>
        {__ctHelpers.ifElse({
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
            type: "object",
            properties: {
                state: true
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, { state: state }, ({ state }) => state.recentEvents.length === 0), <span>No events yet</span>, <div>
              {state.key("recentEvents").mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                const event = __ct_pattern_input.key("element");
                const idx = __ct_pattern_input.key("index");
                return (<ct-hstack key={idx} gap="2">
                  <span>{event.key("label")}</span>
                </ct-hstack>);
            }, {
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/TagEvent"
                    },
                    index: {
                        type: "number"
                    }
                },
                required: ["element"],
                $defs: {
                    TagEvent: {
                        type: "object",
                        properties: {
                            label: {
                                type: "string"
                            }
                        },
                        required: ["label"]
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
            </div>)}
        {__ctHelpers.ifElse({
            type: "boolean",
            asCell: true
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __ctHelpers.JSONSchema, showList, __ctHelpers.derive({
            type: "object",
            properties: {
                count: {
                    type: "number"
                },
                sorted: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Item"
                    }
                }
            },
            required: ["count", "sorted"],
            $defs: {
                Item: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string"
                        },
                        value: {
                            type: "number"
                        }
                    },
                    required: ["name", "value"]
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
        } as const satisfies __ctHelpers.JSONSchema, {
            count: count,
            sorted: sorted
        }, ({ count, sorted }) => (() => {
            const itemCount = count + " items";
            return (<div>
                <span>{itemCount}</span>
                {sorted.map((item: Item) => (<span>{item.name}</span>))}
              </div>);
        })()), <span>Hidden</span>)}
      </div>),
    };
}, {
    type: "object",
    properties: {
        user: {
            type: "object",
            properties: {
                settings: {
                    type: "object",
                    properties: {
                        notifications: {
                            type: "boolean"
                        }
                    },
                    required: ["notifications"]
                }
            },
            required: ["settings"]
        },
        recentEvents: {
            type: "array",
            items: {
                $ref: "#/$defs/TagEvent"
            }
        },
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            }
        }
    },
    required: ["user", "recentEvents", "items"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                value: {
                    type: "number"
                }
            },
            required: ["name", "value"]
        },
        TagEvent: {
            type: "object",
            properties: {
                label: {
                    type: "string"
                }
            },
            required: ["label"]
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
