import * as __ctHelpers from "commontools";
/**
 * FIXTURE: computed-map-in-ternary-branch
 * Verifies: .map() on a computed() result inside a ternary branch stays as
 * plain Array.map() — NOT mapWithPattern — because the ternary is lowered to
 * ifElse → derive by CapabilityLowering, and inside that derive the computed
 * OpaqueRef capture is auto-unwrapped to a plain array.
 *
 * Contrast with pattern-nested-jsx-map where the .map() receiver is a Cell
 * input (celllike_requires_rewrite) which is NOT auto-unwrapped in derives,
 * so mapWithPattern is correct there.
 *
 * The ternary branch must contain a non-trivial reactive expression (here:
 * `count + " people"`) that is NOT an existing helper boundary, so
 * CapabilityLowering wraps the entire branch in a derive.  Without that
 * expression the branch would not be derive-wrapped and mapWithPattern on the
 * OpaqueRef would work fine.
 *
 * Expected transform:
 * - adminData = computed(...) → derive(...)
 * - count = computed(...)    → derive(...)
 * - showAdmin ternary → ifElse(showAdmin, derive({adminData, count}, callback), null)
 * - adminData.map(...) INSIDE the derive callback → plain Array.map (NOT mapWithPattern)
 * - people.map(...) OUTSIDE the ternary → people.mapWithPattern(...) (Cell, not unwrapped)
 */
import { Cell, computed, Default, pattern, UI, Writable } from "commontools";
interface Person {
    name: string;
    rank: number;
}
interface PatternInput {
    people?: Cell<Default<Person[], [
    ]>>;
}
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
                        $ref: "#/$defs/UIRenderable",
                        asOpaque: true
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
        } as const satisfies __ctHelpers.JSONSchema, showAdmin, __ctHelpers.derive({
            type: "object",
            properties: {
                count: {
                    type: "number",
                    asOpaque: true
                },
                adminData: {
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
                    },
                    asOpaque: true
                }
            },
            required: ["count", "adminData"]
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }, {
                    type: "object",
                    properties: {}
                }, {
                    $ref: "#/$defs/UIRenderable",
                    asOpaque: true
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
            adminData: adminData
        }, ({ count, adminData }) => (<div>
              <span>{__ctHelpers.derive({
            type: "object",
            properties: {
                count: {
                    type: "number",
                    asOpaque: true
                }
            },
            required: ["count"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { count: count }, ({ count }) => count + " people")}</span>
              <ul>
                {adminData.map((entry) => (<li>
                    {__ctHelpers.ifElse({
                type: "boolean",
                asOpaque: true
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "string"
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "string"
            } as const satisfies __ctHelpers.JSONSchema, {
                "enum": ["", "\u2605 "]
            } as const satisfies __ctHelpers.JSONSchema, entry.isFirst, "★ ", "")}
                    {entry.name}
                  </li>))}
              </ul>
            </div>)), null)}
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
                    $ref: "#/$defs/UIRenderable",
                    asOpaque: true
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
