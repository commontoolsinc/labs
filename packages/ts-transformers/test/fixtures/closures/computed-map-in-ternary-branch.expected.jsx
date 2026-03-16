import * as __ctHelpers from "commontools";
import { Cell, computed, Default, pattern, UI, Writable } from "commontools";
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
    } as const satisfies __ctHelpers.JSONSchema);
    const adminData = __ctHelpers.derive({
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
    } as const satisfies __ctHelpers.JSONSchema, {
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
    } as const satisfies __ctHelpers.JSONSchema, { people: people }, ({ people }) => [...people.get()]
        .sort((a, b) => a.rank - b.rank)
        .map((p) => ({ name: p.name, rank: p.rank, isFirst: p.rank === 1 })));
    const count = __ctHelpers.derive({
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
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, { people: people }, ({ people }) => people.get().length);
    return {
        [UI]: (<div>
        {people.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
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
            } as const satisfies __ctHelpers.JSONSchema, {
                anyOf: [{
                        $ref: "https://commonfabric.org/schemas/vnode.json"
                    }, {
                        type: "object",
                        properties: {}
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
            } as const satisfies __ctHelpers.JSONSchema), {})}
        {__ctHelpers.ifElse({
            type: "boolean",
            asCell: true
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "null"
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{
                    type: "null"
                }, {
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __ctHelpers.JSONSchema, showAdmin, <div>
              <span>{__ctHelpers.derive({
            type: "object",
            properties: {
                count: {
                    type: "number"
                }
            },
            required: ["count"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { count: count }, ({ count }) => count + " people")}</span>
              <ul>
                {adminData.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                const entry = __ct_pattern_input.key("element");
                return (<li>
                    {__ctHelpers.ifElse({
                    type: "boolean"
                } as const satisfies __ctHelpers.JSONSchema, {
                    type: "string"
                } as const satisfies __ctHelpers.JSONSchema, {
                    type: "string"
                } as const satisfies __ctHelpers.JSONSchema, {
                    "enum": ["", "\u2605 "]
                } as const satisfies __ctHelpers.JSONSchema, entry.key("isFirst"), "★ ", "")}
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
            } as const satisfies __ctHelpers.JSONSchema, {
                anyOf: [{
                        $ref: "https://commonfabric.org/schemas/vnode.json"
                    }, {
                        type: "object",
                        properties: {}
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
            } as const satisfies __ctHelpers.JSONSchema), {})}
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
                    type: "object",
                    properties: {}
                }, {
                    $ref: "#/$defs/UIRenderable"
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
