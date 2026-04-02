function __ctHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { Cell, computed, Default, pattern, UI, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
interface Person {
    name: string;
    rank: number;
}
interface PatternInput {
    people?: Cell<Default<Person[], [
    ]>>;
}
// FIXTURE: computed-map-in-ternary-branch
// Verifies: a computed array used inside a ternary JSX branch stays pattern-lowered
//   const adminData = computed(() => [...people.get()].sort(...).map(...))
//   adminData.map((entry) => <li>...) → adminData.mapWithPattern(pattern(...), {})
//   showAdmin ? <div>...</div> : null → ifElse(showAdmin, <div>...</div>, null)
// Context: The outer `people.map(...)` is over a pattern input cell, while the
//   inner `adminData.map(...)` is over compute-owned data but still lowered in
//   pattern context when rendered from the ternary branch.
export default pattern((__ct_pattern_input) => {
    const people = __ct_pattern_input.key("people");
    const showAdmin = Writable.of(false, {
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema);
    const adminData = __cfHelpers.derive({
        type: "object",
        properties: {
            people: {
                type: "array",
                items: {
                    $ref: "#/$defs/Person"
                },
                asCell: true
            }
        },
        required: ["people"],
        $defs: {
            Person: {
                type: "object",
                properties: {
                    name: {
                        type: "string"
                    },
                    rank: {
                        type: "number"
                    }
                },
                required: ["name", "rank"]
            }
        }
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "array",
        items: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                rank: {
                    type: "number"
                },
                isFirst: {
                    type: "boolean"
                }
            },
            required: ["name", "rank", "isFirst"]
        }
    } as const satisfies __cfHelpers.JSONSchema, { people: people }, ({ people }) => [...people.get()]
        .sort((a, b) => a.rank - b.rank)
        .map((p) => ({ name: p.name, rank: p.rank, isFirst: p.rank === 1 })));
    const count = __cfHelpers.derive({
        type: "object",
        properties: {
            people: {
                type: "array",
                items: {
                    $ref: "#/$defs/Person"
                },
                asCell: true
            }
        },
        required: ["people"],
        $defs: {
            Person: {
                type: "object",
                properties: {
                    name: {
                        type: "string"
                    },
                    rank: {
                        type: "number"
                    }
                },
                required: ["name", "rank"]
            }
        }
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, { people: people }, ({ people }) => people.get().length);
    return {
        [UI]: (<div>
        {people.mapWithPattern(__cfHelpers.pattern(__ct_pattern_input => {
                const person = __ct_pattern_input.key("element");
                return (<span>{person.key("name")}</span>);
            }, {
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Person"
                    }
                },
                required: ["element"],
                $defs: {
                    Person: {
                        type: "object",
                        properties: {
                            name: {
                                type: "string"
                            },
                            rank: {
                                type: "number"
                            }
                        },
                        required: ["name", "rank"]
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
        {__cfHelpers.ifElse({
            type: "boolean",
            asCell: true
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
        } as const satisfies __cfHelpers.JSONSchema, showAdmin, <div>
              <span>{__cfHelpers.derive({
            type: "object",
            properties: {
                count: {
                    type: "number"
                }
            },
            required: ["count"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { count: count }, ({ count }) => count + " people")}</span>
              <ul>
                {adminData.mapWithPattern(__cfHelpers.pattern(__ct_pattern_input => {
                const entry = __ct_pattern_input.key("element");
                return (<li>
                    {__cfHelpers.ifElse({
                    type: "boolean"
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "string"
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "string"
                } as const satisfies __cfHelpers.JSONSchema, {
                    "enum": ["", "\u2605 "]
                } as const satisfies __cfHelpers.JSONSchema, entry.key("isFirst"), "★ ", "")}
                    {entry.key("name")}
                  </li>);
            }, {
                type: "object",
                properties: {
                    element: {
                        type: "object",
                        properties: {
                            name: {
                                type: "string"
                            },
                            rank: {
                                type: "number"
                            },
                            isFirst: {
                                type: "boolean"
                            }
                        },
                        required: ["name", "rank", "isFirst"]
                    }
                },
                required: ["element"]
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
              </ul>
            </div>, null)}
      </div>),
    };
}, {
    type: "object",
    properties: {
        people: {
            type: "array",
            items: {
                $ref: "#/$defs/Person"
            },
            "default": [],
            asCell: true
        }
    },
    $defs: {
        Person: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                rank: {
                    type: "number"
                }
            },
            required: ["name", "rank"]
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
