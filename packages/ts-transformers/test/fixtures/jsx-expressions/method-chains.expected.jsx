function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { computed, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const __cfModuleCallback_1 = __cfHardenFn(({ element: name, params: {} }) => (<li>{__cfHelpers.derive({
    type: "object",
    properties: {
        name: {
            type: "string"
        }
    },
    required: ["name"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema, { name: name }, ({ name }) => name.trim().toLowerCase().replace(" ", "-"))}</li>));
interface State {
    text: string;
    searchTerm: string;
    items: number[];
    start: number;
    end: number;
    threshold: number;
    factor: number;
    names: string[];
    prefix: string;
    prices: number[];
    discount: number;
    taxRate: number;
    users: Array<{
        name: string;
        age: number;
        active: boolean;
    }>;
    minAge: number;
    words: string[];
    separator: string;
}
// FIXTURE: method-chains
// Verifies: chained method calls and array method chains in JSX are wrapped in derive()
//   state.text.trim().toLowerCase()          → derive({text}, ...)
//   state.items.filter(fn).map(fn)           → .filterWithPattern(...).mapWithPattern(...)
//   state.prices.reduce(fn, 0)               → derive({prices, discount}, ...)
// Context: Covers string chains, filter/map chains, reactive args, computed values, complex predicates
export default pattern((state) => {
    return {
        [UI]: (<div>
        <h3>Chained String Methods</h3>
        {/* Simple chain */}
        <p>Trimmed lower: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        text: {
                            type: "string"
                        }
                    },
                    required: ["text"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                text: state.key("text")
            } }, ({ state }) => state.text.trim().toLowerCase())}</p>

        {/* Chain with reactive argument */}
        <p>
          Contains search:{" "}
          {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        text: {
                            type: "string"
                        },
                        searchTerm: {
                            type: "string"
                        }
                    },
                    required: ["text", "searchTerm"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                text: state.key("text"),
                searchTerm: state.key("searchTerm")
            } }, ({ state }) => state.text.toLowerCase().includes(state.searchTerm.toLowerCase()))}
        </p>

        {/* Longer chain */}
        <p>
          Processed:{" "}
          {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        text: {
                            type: "string"
                        }
                    },
                    required: ["text"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                text: state.key("text")
            } }, ({ state }) => state.text.trim().toLowerCase().replace("old", "new").toUpperCase())}
        </p>

        <h3>Array Method Chains</h3>
        {/* Filter then length */}
        <p>
          Count above threshold:{" "}
          {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        items: {
                            type: "array",
                            items: {
                                type: "number"
                            }
                        },
                        threshold: {
                            type: "number"
                        }
                    },
                    required: ["items", "threshold"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                items: state.key("items"),
                threshold: state.key("threshold")
            } }, ({ state }) => state.items.filter((x) => x > state.threshold).length)}
        </p>

        {/* Filter then map */}
        <ul>
          {state.key("items").filterWithPattern(__cfHelpers.pattern(__cf_pattern_input => {
            const x = __cf_pattern_input.key("element");
            const state = __cf_pattern_input.key("params", "state");
            return __cfHelpers.derive({
                type: "object",
                properties: {
                    x: {
                        type: "number"
                    },
                    state: {
                        type: "object",
                        properties: {
                            threshold: {
                                type: "number"
                            }
                        },
                        required: ["threshold"]
                    }
                },
                required: ["x", "state"]
            } as const satisfies __cfHelpers.JSONSchema, {
                type: "boolean"
            } as const satisfies __cfHelpers.JSONSchema, {
                x: x,
                state: {
                    threshold: state.key("threshold")
                }
            }, ({ x, state }) => x > state.threshold);
        }, {
            type: "object",
            properties: {
                element: {
                    type: "number"
                },
                params: {
                    type: "object",
                    properties: {
                        state: {
                            type: "object",
                            properties: {
                                threshold: {
                                    type: "number"
                                }
                            },
                            required: ["threshold"]
                        }
                    },
                    required: ["state"]
                }
            },
            required: ["element", "params"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema), {
            state: {
                threshold: state.key("threshold")
            }
        }).mapWithPattern(__cfHelpers.pattern(__cf_pattern_input => {
            const x = __cf_pattern_input.key("element");
            const state = __cf_pattern_input.key("params", "state");
            return (<li>Value: {__cfHelpers.derive({
                type: "object",
                properties: {
                    x: {
                        type: "number"
                    },
                    state: {
                        type: "object",
                        properties: {
                            factor: {
                                type: "number"
                            }
                        },
                        required: ["factor"]
                    }
                },
                required: ["x", "state"]
            } as const satisfies __cfHelpers.JSONSchema, {
                type: "number"
            } as const satisfies __cfHelpers.JSONSchema, {
                x: x,
                state: {
                    factor: state.key("factor")
                }
            }, ({ x, state }) => x * state.factor)}</li>);
        }, {
            type: "object",
            properties: {
                element: {
                    type: "number"
                },
                params: {
                    type: "object",
                    properties: {
                        state: {
                            type: "object",
                            properties: {
                                factor: {
                                    type: "number"
                                }
                            },
                            required: ["factor"]
                        }
                    },
                    required: ["state"]
                }
            },
            required: ["element", "params"]
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
                factor: state.key("factor")
            }
        })}
        </ul>

        {/* Multiple filters */}
        <p>
          Double filter count:{" "}
          {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        end: {
                            type: "number"
                        },
                        items: {
                            type: "array",
                            items: {
                                type: "number"
                            }
                        },
                        start: {
                            type: "number"
                        }
                    },
                    required: ["end", "items", "start"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                items: state.key("items"),
                start: state.key("start"),
                end: state.key("end")
            } }, ({ state }) => state.items.filter((x) => x > state.start).filter((x) => x < state.end).length)}
        </p>

        <h3>Methods with Reactive Arguments</h3>
        {/* Slice with reactive indices */}
        <p>
          Sliced items: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        items: {
                            type: "array",
                            items: {
                                type: "number"
                            }
                        },
                        start: {
                            type: "number"
                        },
                        end: {
                            type: "number"
                        }
                    },
                    required: ["items", "start", "end"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                items: state.key("items"),
                start: state.key("start"),
                end: state.key("end")
            } }, ({ state }) => state.items.slice(state.start, state.end).join(", "))}
        </p>

        {/* String methods with reactive args */}
        <p>
          Starts with:{" "}
          {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        names: {
                            type: "array",
                            items: {
                                type: "string"
                            }
                        },
                        prefix: {
                            type: "string"
                        }
                    },
                    required: ["names", "prefix"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                names: state.key("names"),
                prefix: state.key("prefix")
            } }, ({ state }) => state.names.filter((n) => n.startsWith(state.prefix)).join(", "))}
        </p>

        {/* Array find with reactive predicate */}
        <p>
          First match: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        names: {
                            type: "array",
                            items: {
                                type: "string"
                            }
                        },
                        searchTerm: {
                            type: "string"
                        }
                    },
                    required: ["names", "searchTerm"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: ["string", "undefined"]
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                names: state.key("names"),
                searchTerm: state.key("searchTerm")
            } }, ({ state }) => state.names.find((n) => n.includes(state.searchTerm)))}
        </p>

        <h3>Complex Method Combinations</h3>
        {/* Map with chained operations inside */}
        <ul>
          {state.key("names").mapWithPattern(__cfHelpers.pattern(__cfModuleCallback_1, {
                type: "object",
                properties: {
                    element: {
                        type: "string"
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

        {/* Reduce with reactive accumulator */}
        <p>
          Total with discount: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        prices: {
                            type: "array",
                            items: {
                                type: "number"
                            }
                        },
                        discount: {
                            type: "number"
                        }
                    },
                    required: ["prices", "discount"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                prices: state.key("prices"),
                discount: state.key("discount")
            } }, ({ state }) => state.prices.reduce((sum, price) => sum + price * (1 - state.discount), 0))}
        </p>

        {/* Method result used in computation */}
        <p>
          Average * factor:{" "}
          {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        items: {
                            type: "array",
                            items: {
                                type: "number"
                            }
                        },
                        factor: {
                            type: "number"
                        }
                    },
                    required: ["items", "factor"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                items: state.key("items"),
                factor: state.key("factor")
            } }, ({ state }) => (state.items.reduce((a, b) => a + b, 0) / state.items.length) *
            state.factor)}
        </p>

        <h3>Methods on Computed Values</h3>
        {/* Method on binary expression result */}
        <p>
          Formatted price: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        prices: {
                            type: "array",
                            items: {
                                type: "number"
                            }
                        },
                        discount: {
                            type: "number"
                        }
                    },
                    required: ["prices", "discount"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                prices: state.key("prices"),
                discount: state.key("discount")
            } }, ({ state }) => (state.prices[0]! * (1 - state.discount)).toFixed(2))}
        </p>

        {/* Method on conditional result */}
        <p>
          Conditional trim:{" "}
          {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        text: {
                            type: "string"
                        },
                        prefix: {
                            type: "string"
                        }
                    },
                    required: ["text", "prefix"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                text: state.key("text"),
                prefix: state.key("prefix")
            } }, ({ state }) => (state.text.length > 10 ? state.text : state.prefix).trim())}
        </p>

        {/* Method chain on computed value */}
        <p>
          Complex:{" "}
          {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        text: {
                            type: "string"
                        },
                        prefix: {
                            type: "string"
                        }
                    },
                    required: ["text", "prefix"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                text: state.key("text"),
                prefix: state.key("prefix")
            } }, ({ state }) => (state.text + " " + state.prefix).trim().toLowerCase().split(" ")
            .join("-"))}
        </p>

        <h3>Array Methods with Complex Predicates</h3>
        {/* Filter with multiple conditions */}
        <p>
          Active adults:{" "}
          {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        users: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    name: {
                                        type: "string"
                                    },
                                    age: {
                                        type: "number"
                                    },
                                    active: {
                                        type: "boolean"
                                    }
                                },
                                required: ["name", "age", "active"]
                            }
                        },
                        minAge: {
                            type: "number"
                        }
                    },
                    required: ["users", "minAge"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                users: state.key("users"),
                minAge: state.key("minAge")
            } }, ({ state }) => state.users.filter((u) => u.age >= state.minAge && u.active).length)}
        </p>

        {/* Map with conditional logic */}
        <ul>
          {state.key("users").mapWithPattern(__cfHelpers.pattern(__cf_pattern_input => {
                const u = __cf_pattern_input.key("element");
                return (<li>{__cfHelpers.ifElse({
                    type: "boolean"
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "string"
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "string"
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "string"
                } as const satisfies __cfHelpers.JSONSchema, u.key("active"), __cfHelpers.derive({
                    type: "object",
                    properties: {
                        u: {
                            type: "object",
                            properties: {
                                name: {
                                    type: "string"
                                }
                            },
                            required: ["name"]
                        }
                    },
                    required: ["u"]
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "string"
                } as const satisfies __cfHelpers.JSONSchema, { u: {
                        name: u.key("name")
                    } }, ({ u }) => u.name.toUpperCase()), __cfHelpers.derive({
                    type: "object",
                    properties: {
                        u: {
                            type: "object",
                            properties: {
                                name: {
                                    type: "string"
                                }
                            },
                            required: ["name"]
                        }
                    },
                    required: ["u"]
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "string"
                } as const satisfies __cfHelpers.JSONSchema, { u: {
                        name: u.key("name")
                    } }, ({ u }) => u.name.toLowerCase()))}</li>);
            }, {
                type: "object",
                properties: {
                    element: {
                        type: "object",
                        properties: {
                            name: {
                                type: "string"
                            },
                            age: {
                                type: "number"
                            },
                            active: {
                                type: "boolean"
                            }
                        },
                        required: ["name", "age", "active"]
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

        {/* Some/every with reactive predicates */}
        <p>
          Has adults:{" "}
          {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["Yes", "No"]
        } as const satisfies __cfHelpers.JSONSchema, __cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        users: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    name: {
                                        type: "string"
                                    },
                                    age: {
                                        type: "number"
                                    },
                                    active: {
                                        type: "boolean"
                                    }
                                },
                                required: ["name", "age", "active"]
                            }
                        },
                        minAge: {
                            type: "number"
                        }
                    },
                    required: ["users", "minAge"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                users: state.key("users"),
                minAge: state.key("minAge")
            } }, ({ state }) => state.users.some((u) => u.age >= state.minAge)), "Yes", "No")}
        </p>
        <p>All active: {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["Yes", "No"]
        } as const satisfies __cfHelpers.JSONSchema, __cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        users: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    name: {
                                        type: "string"
                                    },
                                    age: {
                                        type: "number"
                                    },
                                    active: {
                                        type: "boolean"
                                    }
                                },
                                required: ["name", "age", "active"]
                            }
                        }
                    },
                    required: ["users"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                users: state.key("users")
            } }, ({ state }) => state.users.every((u) => u.active)), "Yes", "No")}</p>

        <h3>Method Calls in Expressions</h3>
        {/* Method result in arithmetic */}
        <p>
          Length sum: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        text: {
                            type: "string"
                        },
                        prefix: {
                            type: "string"
                        }
                    },
                    required: ["text", "prefix"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                text: state.key("text"),
                prefix: state.key("prefix")
            } }, ({ state }) => state.text.trim().length + state.prefix.trim().length)}
        </p>

        {/* Method result in comparison */}
        <p>
          Is long: {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["Yes", "No"]
        } as const satisfies __cfHelpers.JSONSchema, __cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        text: {
                            type: "string"
                        },
                        threshold: {
                            type: "number"
                        }
                    },
                    required: ["text", "threshold"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                text: state.key("text"),
                threshold: state.key("threshold")
            } }, ({ state }) => state.text.trim().length > state.threshold), "Yes", "No")}
        </p>

        {/* Multiple method results combined */}
        <p>Joined: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        words: {
                            type: "array",
                            items: {
                                type: "string"
                            }
                        },
                        separator: {
                            type: "string"
                        }
                    },
                    required: ["words", "separator"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                words: state.key("words"),
                separator: state.key("separator")
            } }, ({ state }) => state.words.join(state.separator).toUpperCase())}</p>
      </div>),
    };
}, {
    type: "object",
    properties: {
        text: {
            type: "string"
        },
        searchTerm: {
            type: "string"
        },
        items: {
            type: "array",
            items: {
                type: "number"
            }
        },
        start: {
            type: "number"
        },
        end: {
            type: "number"
        },
        threshold: {
            type: "number"
        },
        factor: {
            type: "number"
        },
        names: {
            type: "array",
            items: {
                type: "string"
            }
        },
        prefix: {
            type: "string"
        },
        prices: {
            type: "array",
            items: {
                type: "number"
            }
        },
        discount: {
            type: "number"
        },
        taxRate: {
            type: "number"
        },
        users: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    name: {
                        type: "string"
                    },
                    age: {
                        type: "number"
                    },
                    active: {
                        type: "boolean"
                    }
                },
                required: ["name", "age", "active"]
            }
        },
        minAge: {
            type: "number"
        },
        words: {
            type: "array",
            items: {
                type: "string"
            }
        },
        separator: {
            type: "string"
        }
    },
    required: ["text", "searchTerm", "items", "start", "end", "threshold", "factor", "names", "prefix", "prices", "discount", "taxRate", "users", "minAge", "words", "separator"]
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
