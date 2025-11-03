import * as __ctHelpers from "commontools";
import { recipe, UI } from "commontools";
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
export default recipe({
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
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    return {
        [UI]: (<div>
        <h3>Chained String Methods</h3>
        {/* Simple chain */}
        <p>Trimmed lower: {__ctHelpers.derive({ state: {
                text: state.text
            } }, ({ state }) => state.text.trim().toLowerCase())}</p>

        {/* Chain with reactive argument */}
        <p>
          Contains search:{" "}
          {__ctHelpers.derive({ state: {
                text: state.text,
                searchTerm: state.searchTerm
            } }, ({ state }) => state.text.toLowerCase().includes(state.searchTerm.toLowerCase()))}
        </p>

        {/* Longer chain */}
        <p>
          Processed:{" "}
          {__ctHelpers.derive({ state: {
                text: state.text
            } }, ({ state }) => state.text.trim().toLowerCase().replace("old", "new").toUpperCase())}
        </p>

        <h3>Array Method Chains</h3>
        {/* Filter then length */}
        <p>
          Count above threshold:{" "}
          {__ctHelpers.derive({ state: {
                items: state.items,
                threshold: state.threshold
            } }, ({ state }) => state.items.filter((x) => x > state.threshold).length)}
        </p>

        {/* Filter then map */}
        <ul>
          {__ctHelpers.derive({ state: {
                items: state.items,
                threshold: state.threshold
            } }, ({ state }) => state.items.filter((x) => x > state.threshold)).mapWithPattern(__ctHelpers.recipe({
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                element: {
                    type: "number",
                    asOpaque: true
                },
                params: {
                    type: "object",
                    properties: {
                        state: {
                            type: "object",
                            properties: {
                                factor: {
                                    type: "number",
                                    asOpaque: true
                                }
                            },
                            required: ["factor"]
                        }
                    },
                    required: ["state"]
                }
            },
            required: ["element", "params"]
        } as const satisfies __ctHelpers.JSONSchema, ({ element: x, params: { state } }) => (<li>Value: {__ctHelpers.derive({
            x: x,
            state: {
                factor: state.factor
            }
        }, ({ x, state }) => x * state.factor)}</li>)), {
            state: {
                factor: state.factor
            }
        })}
        </ul>

        {/* Multiple filters */}
        <p>
          Double filter count:{" "}
          {__ctHelpers.derive({ state: {
                items: state.items,
                start: state.start,
                end: state.end
            } }, ({ state }) => state.items.filter((x) => x > state.start).filter((x) => x < state.end).length)}
        </p>

        <h3>Methods with Reactive Arguments</h3>
        {/* Slice with reactive indices */}
        <p>
          Sliced items: {__ctHelpers.derive({ state: {
                items: state.items,
                start: state.start,
                end: state.end
            } }, ({ state }) => state.items.slice(state.start, state.end).join(", "))}
        </p>

        {/* String methods with reactive args */}
        <p>
          Starts with:{" "}
          {__ctHelpers.derive({ state: {
                names: state.names,
                prefix: state.prefix
            } }, ({ state }) => state.names.filter((n) => n.startsWith(state.prefix)).join(", "))}
        </p>

        {/* Array find with reactive predicate */}
        <p>
          First match: {__ctHelpers.derive({ state: {
                names: state.names,
                searchTerm: state.searchTerm
            } }, ({ state }) => state.names.find((n) => n.includes(state.searchTerm)))}
        </p>

        <h3>Complex Method Combinations</h3>
        {/* Map with chained operations inside */}
        <ul>
          {state.names.mapWithPattern(__ctHelpers.recipe({
                $schema: "https://json-schema.org/draft/2020-12/schema",
                type: "object",
                properties: {
                    element: {
                        type: "string"
                    },
                    params: {
                        type: "object",
                        properties: {}
                    }
                },
                required: ["element", "params"]
            } as const satisfies __ctHelpers.JSONSchema, ({ element: name, params: {} }) => (<li>{__ctHelpers.derive(name, (name) => name.trim().toLowerCase().replace(" ", "-"))}</li>)), {})}
        </ul>

        {/* Reduce with reactive accumulator */}
        <p>
          Total with discount: {__ctHelpers.derive({ state: {
                prices: state.prices,
                discount: state.discount
            } }, ({ state }) => state.prices.reduce((sum, price) => sum + price * (1 - state.discount), 0))}
        </p>

        {/* Method result used in computation */}
        <p>
          Average * factor:{" "}
          {__ctHelpers.derive({ state: {
                items: state.items,
                factor: state.factor
            } }, ({ state }) => (state.items.reduce((a, b) => a + b, 0) / state.items.length) *
            state.factor)}
        </p>

        <h3>Methods on Computed Values</h3>
        {/* Method on binary expression result */}
        <p>
          Formatted price: {__ctHelpers.derive({ state: {
                prices: state.prices,
                discount: state.discount
            } }, ({ state }) => (state.prices[0] * (1 - state.discount)).toFixed(2))}
        </p>

        {/* Method on conditional result */}
        <p>
          Conditional trim:{" "}
          {__ctHelpers.derive({ state: {
                text: state.text,
                prefix: state.prefix
            } }, ({ state }) => (state.text.length > 10 ? state.text : state.prefix).trim())}
        </p>

        {/* Method chain on computed value */}
        <p>
          Complex:{" "}
          {__ctHelpers.derive({ state: {
                text: state.text,
                prefix: state.prefix
            } }, ({ state }) => (state.text + " " + state.prefix).trim().toLowerCase().split(" ")
            .join("-"))}
        </p>

        <h3>Array Methods with Complex Predicates</h3>
        {/* Filter with multiple conditions */}
        <p>
          Active adults:{" "}
          {__ctHelpers.derive({ state: {
                users: state.users,
                minAge: state.minAge
            } }, ({ state }) => state.users.filter((u) => u.age >= state.minAge && u.active).length)}
        </p>

        {/* Map with conditional logic */}
        <ul>
          {state.users.mapWithPattern(__ctHelpers.recipe({
                $schema: "https://json-schema.org/draft/2020-12/schema",
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
                    },
                    params: {
                        type: "object",
                        properties: {}
                    }
                },
                required: ["element", "params"]
            } as const satisfies __ctHelpers.JSONSchema, ({ element: u, params: {} }) => (<li>{__ctHelpers.ifElse(u.active, __ctHelpers.derive({ u: {
                    name: u.name
                } }, ({ u }) => u.name.toUpperCase()), __ctHelpers.derive({ u: {
                    name: u.name
                } }, ({ u }) => u.name.toLowerCase()))}</li>)), {})}
        </ul>

        {/* Some/every with reactive predicates */}
        <p>
          Has adults:{" "}
          {__ctHelpers.ifElse(__ctHelpers.derive({ state: {
                users: state.users,
                minAge: state.minAge
            } }, ({ state }) => state.users.some((u) => u.age >= state.minAge)), "Yes", "No")}
        </p>
        <p>All active: {__ctHelpers.ifElse(__ctHelpers.derive({ state: {
                users: state.users
            } }, ({ state }) => state.users.every((u) => u.active)), "Yes", "No")}</p>

        <h3>Method Calls in Expressions</h3>
        {/* Method result in arithmetic */}
        <p>
          Length sum: {__ctHelpers.derive({ state: {
                text: state.text,
                prefix: state.prefix
            } }, ({ state }) => state.text.trim().length + state.prefix.trim().length)}
        </p>

        {/* Method result in comparison */}
        <p>
          Is long: {__ctHelpers.ifElse(__ctHelpers.derive({ state: {
                text: state.text,
                threshold: state.threshold
            } }, ({ state }) => state.text.trim().length > state.threshold), "Yes", "No")}
        </p>

        {/* Multiple method results combined */}
        <p>Joined: {__ctHelpers.derive({ state: {
                words: state.words,
                separator: state.separator
            } }, ({ state }) => state.words.join(state.separator).toUpperCase())}</p>
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
