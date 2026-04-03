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
// FIXTURE: computed-map-in-derived-branch
// Verifies: moving a reactive computation out of a JSX slot forces the whole
//   branch into derive(), so nested maps run in compute context and stay plain
//   const peopleCount = count + " people" inside an IIFE branch → branch derive()
//   adminData.map((entry) => <li>...) → stays plain .map() inside the derive callback
// Context: opposite of computed-map-in-ternary-branch; no JSX-local rewrite is
//   available for the hoisted `peopleCount` initializer.
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
                }, {}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __ctHelpers.JSONSchema, showAdmin, __ctHelpers.derive({
            type: "object",
            properties: {
                count: {
                    type: "number"
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
                    }
                }
            },
            required: ["count", "adminData"]
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
            adminData: adminData
        }, ({ count, adminData }) => (() => {
            const peopleCount = count + " people";
            return (<div>
                <span>{peopleCount}</span>
                <ul>
                  {adminData.map((entry) => (<li>
                      {entry.isFirst ? "★ " : ""}
                      {entry.name}
                    </li>))}
                </ul>
              </div>);
        })()), null)}
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
