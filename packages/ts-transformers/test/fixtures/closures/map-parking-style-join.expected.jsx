function __ctHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { computed, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
interface Spot {
    active: boolean;
    spotNumber: string;
    label?: string;
}
interface Person {
    name: string;
    email: string;
    commuteMode: string;
    priorityRank: number;
    defaultSpot?: string;
    spotPreferences: string[];
    isFirst: boolean;
    isLast: boolean;
}
interface State {
    people: Person[];
    editingPersonName: string | null;
    removePersonConfirmTarget: string | null;
    spots: Spot[];
}
// FIXTURE: map-parking-style-join
// Verifies: nested plain-array joins inside a reactive map callback stay plain in complex branches
//   state.people.map(fn)                    -> state.key("people").mapWithPattern(pattern(...), ...)
//   state.spots.filter(...).map(... )       -> derive(...).filter(...).map(...) stays plain inside computed()
//   spotPreferences.map((n) => "#" + n)     -> nested plain-array callback stays plain and does not capture n
// Context: Realistic callback body mixing computed aliases, destructuring, conditional JSX, and joined plain-array labels
export default pattern((state) => {
    return {
        [UI]: (<div>
        {state.key("people").mapWithPattern(__cfHelpers.pattern(__ct_pattern_input => {
                const person = __ct_pattern_input.key("element");
                const state = __ct_pattern_input.key("params", "state");
                const personName = person.key("name"), email = person.key("email"), commuteMode = person.key("commuteMode"), priorityRank = person.key("priorityRank"), defaultSpot = person.key("defaultSpot"), spotPreferences = person.key("spotPreferences"), isFirst = person.key("isFirst"), isLast = person.key("isLast");
                const isEditing = __cfHelpers.derive({
                    type: "object",
                    properties: {
                        state: {
                            type: "object",
                            properties: {
                                editingPersonName: {
                                    anyOf: [{
                                            type: "string"
                                        }, {
                                            type: "null"
                                        }]
                                }
                            },
                            required: ["editingPersonName"]
                        },
                        personName: {
                            type: "string"
                        }
                    },
                    required: ["state", "personName"]
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "boolean"
                } as const satisfies __cfHelpers.JSONSchema, {
                    state: {
                        editingPersonName: state.key("editingPersonName")
                    },
                    personName: personName
                }, ({ state, personName }) => state.editingPersonName === personName);
                const isRemoveConfirm = __cfHelpers.derive({
                    type: "object",
                    properties: {
                        state: {
                            type: "object",
                            properties: {
                                removePersonConfirmTarget: {
                                    anyOf: [{
                                            type: "string"
                                        }, {
                                            type: "null"
                                        }]
                                }
                            },
                            required: ["removePersonConfirmTarget"]
                        },
                        personName: {
                            type: "string"
                        }
                    },
                    required: ["state", "personName"]
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "boolean"
                } as const satisfies __cfHelpers.JSONSchema, {
                    state: {
                        removePersonConfirmTarget: state.key("removePersonConfirmTarget")
                    },
                    personName: personName
                }, ({ state, personName }) => state.removePersonConfirmTarget === personName);
                const activeSpotOpts = __cfHelpers.derive({
                    type: "object",
                    properties: {
                        state: {
                            type: "object",
                            properties: {
                                spots: {
                                    type: "array",
                                    items: {
                                        $ref: "#/$defs/Spot"
                                    }
                                }
                            },
                            required: ["spots"]
                        }
                    },
                    required: ["state"],
                    $defs: {
                        Spot: {
                            type: "object",
                            properties: {
                                active: {
                                    type: "boolean"
                                },
                                spotNumber: {
                                    type: "string"
                                },
                                label: {
                                    type: "string"
                                }
                            },
                            required: ["active", "spotNumber"]
                        }
                    }
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            label: {
                                type: "string"
                            },
                            value: {
                                type: "string"
                            }
                        },
                        required: ["label", "value"]
                    }
                } as const satisfies __cfHelpers.JSONSchema, { state: {
                        spots: state.key("spots")
                    } }, ({ state }) => state.spots
                    .filter((s) => s.active)
                    .map((s) => ({
                    label: "#" + s.spotNumber + (s.label ? " - " + s.label : ""),
                    value: s.spotNumber,
                })));
                return (<section>
              <span>{personName}</span>
              <span>{email}</span>
              <span>{commuteMode}</span>
              <span>{priorityRank}</span>
              {__cfHelpers.ifElse({
                    type: ["string", "undefined"]
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
                        }, {}, {
                            type: "object",
                            properties: {}
                        }]
                } as const satisfies __cfHelpers.JSONSchema, defaultSpot, <span>{defaultSpot}</span>, null)}
              {__cfHelpers.ifElse({
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
                        }, {}, {
                            type: "object",
                            properties: {}
                        }]
                } as const satisfies __cfHelpers.JSONSchema, isFirst, <span>first</span>, null)}
              {__cfHelpers.ifElse({
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
                        }, {}, {
                            type: "object",
                            properties: {}
                        }]
                } as const satisfies __cfHelpers.JSONSchema, isLast, <span>last</span>, null)}
              {__cfHelpers.ifElse({
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
                        }, {}, {
                            type: "object",
                            properties: {}
                        }]
                } as const satisfies __cfHelpers.JSONSchema, isEditing, <span>editing</span>, null)}
              {__cfHelpers.ifElse({
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
                        }, {}, {
                            type: "object",
                            properties: {}
                        }]
                } as const satisfies __cfHelpers.JSONSchema, isRemoveConfirm, <span>removing</span>, null)}
              {__cfHelpers.ifElse({
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
                        }, {}, {
                            type: "object",
                            properties: {}
                        }]
                } as const satisfies __cfHelpers.JSONSchema, __cfHelpers.derive({
                    type: "object",
                    properties: {
                        activeSpotOpts: {
                            type: "object",
                            properties: {
                                length: {
                                    type: "number"
                                }
                            },
                            required: ["length"]
                        }
                    },
                    required: ["activeSpotOpts"]
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "boolean"
                } as const satisfies __cfHelpers.JSONSchema, { activeSpotOpts: {
                        length: activeSpotOpts.key("length")
                    } }, ({ activeSpotOpts }) => activeSpotOpts.length > 0), <span>spots</span>, null)}
              {__cfHelpers.ifElse({
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
                        }, {}, {
                            type: "object",
                            properties: {}
                        }]
                } as const satisfies __cfHelpers.JSONSchema, __cfHelpers.derive({
                    type: "object",
                    properties: {
                        spotPreferences: {
                            type: "array",
                            items: {
                                type: "unknown"
                            }
                        }
                    },
                    required: ["spotPreferences"]
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "boolean"
                } as const satisfies __cfHelpers.JSONSchema, { spotPreferences: spotPreferences }, ({ spotPreferences }) => spotPreferences.length > 0), <span>
                    Prefers: {__cfHelpers.derive({
                    type: "object",
                    properties: {
                        spotPreferences: {
                            type: "array",
                            items: {
                                type: "string"
                            }
                        }
                    },
                    required: ["spotPreferences"]
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "string"
                } as const satisfies __cfHelpers.JSONSchema, { spotPreferences: spotPreferences }, ({ spotPreferences }) => spotPreferences.map((n) => "#" + n).join(", "))}
                  </span>, null)}
            </section>);
            }, {
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Person"
                    },
                    params: {
                        type: "object",
                        properties: {
                            state: {
                                type: "object",
                                properties: {
                                    editingPersonName: {
                                        anyOf: [{
                                                type: "string"
                                            }, {
                                                type: "null"
                                            }]
                                    },
                                    removePersonConfirmTarget: {
                                        anyOf: [{
                                                type: "string"
                                            }, {
                                                type: "null"
                                            }]
                                    },
                                    spots: {
                                        type: "array",
                                        items: {
                                            $ref: "#/$defs/Spot"
                                        }
                                    }
                                },
                                required: ["editingPersonName", "removePersonConfirmTarget", "spots"]
                            }
                        },
                        required: ["state"]
                    }
                },
                required: ["element", "params"],
                $defs: {
                    Spot: {
                        type: "object",
                        properties: {
                            active: {
                                type: "boolean"
                            },
                            spotNumber: {
                                type: "string"
                            },
                            label: {
                                type: "string"
                            }
                        },
                        required: ["active", "spotNumber"]
                    },
                    Person: {
                        type: "object",
                        properties: {
                            name: {
                                type: "string"
                            },
                            email: {
                                type: "string"
                            },
                            commuteMode: {
                                type: "string"
                            },
                            priorityRank: {
                                type: "number"
                            },
                            defaultSpot: {
                                type: "string"
                            },
                            spotPreferences: {
                                type: "array",
                                items: {
                                    type: "string"
                                }
                            },
                            isFirst: {
                                type: "boolean"
                            },
                            isLast: {
                                type: "boolean"
                            }
                        },
                        required: ["name", "email", "commuteMode", "priorityRank", "spotPreferences", "isFirst", "isLast"]
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
                    editingPersonName: state.key("editingPersonName"),
                    removePersonConfirmTarget: state.key("removePersonConfirmTarget"),
                    spots: state.key("spots")
                }
            })}
      </div>),
    };
}, {
    type: "object",
    properties: {
        people: {
            type: "array",
            items: {
                $ref: "#/$defs/Person"
            }
        },
        editingPersonName: {
            anyOf: [{
                    type: "string"
                }, {
                    type: "null"
                }]
        },
        removePersonConfirmTarget: {
            anyOf: [{
                    type: "string"
                }, {
                    type: "null"
                }]
        },
        spots: {
            type: "array",
            items: {
                $ref: "#/$defs/Spot"
            }
        }
    },
    required: ["people", "editingPersonName", "removePersonConfirmTarget", "spots"],
    $defs: {
        Spot: {
            type: "object",
            properties: {
                active: {
                    type: "boolean"
                },
                spotNumber: {
                    type: "string"
                },
                label: {
                    type: "string"
                }
            },
            required: ["active", "spotNumber"]
        },
        Person: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                email: {
                    type: "string"
                },
                commuteMode: {
                    type: "string"
                },
                priorityRank: {
                    type: "number"
                },
                defaultSpot: {
                    type: "string"
                },
                spotPreferences: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                },
                isFirst: {
                    type: "boolean"
                },
                isLast: {
                    type: "boolean"
                }
            },
            required: ["name", "email", "commuteMode", "priorityRank", "spotPreferences", "isFirst", "isLast"]
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
__ctHardenFn(h);
