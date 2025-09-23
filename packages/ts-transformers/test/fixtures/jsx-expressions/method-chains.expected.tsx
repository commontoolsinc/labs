/// <cts-enable />
import { h, recipe, UI, derive, ifElse, JSONSchema } from "commontools";
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
} as const satisfies JSONSchema, (state) => {
    return {
        [UI]: (<div>
        <h3>Chained String Methods</h3>
        {/* Simple chain */}
        <p>Trimmed lower: {commontools_1.derive(state.text, _v1 => _v1.trim().toLowerCase())}</p>

        {/* Chain with reactive argument */}
        <p>Contains search: {commontools_1.derive({ state_text: state.text, state_searchTerm: state.searchTerm }, ({ state_text: _v1, state_searchTerm: _v2 }) => _v1.toLowerCase().includes(_v2.toLowerCase()))}</p>

        {/* Longer chain */}
        <p>Processed: {commontools_1.derive(state.text, _v1 => _v1.trim().toLowerCase().replace("old", "new").toUpperCase())}</p>

        <h3>Array Method Chains</h3>
        {/* Filter then length */}
        <p>Count above threshold: {commontools_1.derive({ state_items: state.items, state_threshold: state.threshold }, ({ state_items: _v1, state_threshold: _v2 }) => _v1.filter(x => x > _v2).length)}</p>

        {/* Filter then map */}
        <ul>
          {commontools_1.derive({ state_items: state.items, state_threshold: state.threshold }, ({ state_items: _v1, state_threshold: _v2 }) => _v1.filter(x => x > _v2)).map(x => (<li>Value: {commontools_1.derive({ x, state_factor: state.factor }, ({ x: x, state_factor: _v2 }) => x * _v2)}</li>))}
        </ul>

        {/* Multiple filters */}
        <p>Double filter count: {commontools_1.derive({ state_items: state.items, state_start: state.start, state_end: state.end }, ({ state_items: _v1, state_start: _v2, state_end: _v3 }) => _v1.filter(x => x > _v2).filter(x => x < _v3).length)}</p>

        <h3>Methods with Reactive Arguments</h3>
        {/* Slice with reactive indices */}
        <p>Sliced items: {commontools_1.derive({ state_items: state.items, state_start: state.start, state_end: state.end }, ({ state_items: _v1, state_start: _v2, state_end: _v3 }) => _v1.slice(_v2, _v3).join(", "))}</p>

        {/* String methods with reactive args */}
        <p>Starts with: {commontools_1.derive({ state_names: state.names, state_prefix: state.prefix }, ({ state_names: _v1, state_prefix: _v2 }) => _v1.filter(n => n.startsWith(_v2)).join(", "))}</p>

        {/* Array find with reactive predicate */}
        <p>First match: {commontools_1.derive({ state_names: state.names, state_searchTerm: state.searchTerm }, ({ state_names: _v1, state_searchTerm: _v2 }) => _v1.find(n => n.includes(_v2)))}</p>

        <h3>Complex Method Combinations</h3>
        {/* Map with chained operations inside */}
        <ul>
          {state.names.map(name => (<li>{commontools_1.derive(name, name => name.trim().toLowerCase().replace(" ", "-"))}</li>))}
        </ul>

        {/* Reduce with reactive accumulator */}
        <p>Total with discount: {commontools_1.derive({ state_prices: state.prices, state_discount: state.discount }, ({ state_prices: _v1, state_discount: _v2 }) => _v1.reduce((sum, price) => sum + price * (1 - _v2), 0))}</p>

        {/* Method result used in computation */}
        <p>Average * factor: {commontools_1.derive({ state_items: state.items, state_items_length: state.items.length, state_factor: state.factor }, ({ state_items: _v1, state_items_length: _v2, state_factor: _v3 }) => (_v1.reduce((a, b) => a + b, 0) / _v2) * _v3)}</p>

        <h3>Methods on Computed Values</h3>
        {/* Method on binary expression result */}
        <p>Formatted price: {commontools_1.derive({ state_prices: state.prices, state_discount: state.discount }, ({ state_prices: _v1, state_discount: _v2 }) => (_v1[0] * (1 - _v2)).toFixed(2))}</p>

        {/* Method on conditional result */}
        <p>Conditional trim: {commontools_1.derive({ state_text: state.text, state_text_length: state.text.length, state_prefix: state.prefix }, ({ state_text: _v1, state_text_length: _v2, state_prefix: _v3 }) => (_v2 > 10 ? _v1 : _v3).trim())}</p>

        {/* Method chain on computed value */}
        <p>Complex: {commontools_1.derive({ state_text: state.text, state_prefix: state.prefix }, ({ state_text: _v1, state_prefix: _v2 }) => (_v1 + " " + _v2).trim().toLowerCase().split(" ").join("-"))}</p>

        <h3>Array Methods with Complex Predicates</h3>
        {/* Filter with multiple conditions */}
        <p>Active adults: {commontools_1.derive({ state_users: state.users, state_minAge: state.minAge }, ({ state_users: _v1, state_minAge: _v2 }) => _v1.filter(u => u.age >= _v2 && u.active).length)}</p>

        {/* Map with conditional logic */}
        <ul>
          {state.users.map(u => (<li>{commontools_1.ifElse(u.active, commontools_1.derive(u.name, _v1 => _v1.toUpperCase()), commontools_1.derive(u.name, _v1 => u.name.toLowerCase()))}</li>))}
        </ul>

        {/* Some/every with reactive predicates */}
        <p>Has adults: {commontools_1.ifElse(commontools_1.derive({ state_users: state.users, state_minAge: state.minAge }, ({ state_users: _v1, state_minAge: _v2 }) => _v1.some(u => u.age >= _v2)), "Yes", "No")}</p>
        <p>All active: {commontools_1.ifElse(commontools_1.derive(state.users, _v1 => _v1.every(u => u.active)), "Yes", "No")}</p>

        <h3>Method Calls in Expressions</h3>
        {/* Method result in arithmetic */}
        <p>Length sum: {commontools_1.derive({ state_text: state.text, state_prefix: state.prefix }, ({ state_text: _v1, state_prefix: _v2 }) => _v1.trim().length + _v2.trim().length)}</p>

        {/* Method result in comparison */}
        <p>Is long: {commontools_1.ifElse(commontools_1.derive({ state_text: state.text, state_threshold: state.threshold }, ({ state_text: _v1, state_threshold: _v2 }) => _v1.trim().length > _v2), "Yes", "No")}</p>

        {/* Multiple method results combined */}
        <p>Joined: {commontools_1.derive({ state_words: state.words, state_separator: state.separator }, ({ state_words: _v1, state_separator: _v2 }) => _v1.join(_v2).toUpperCase())}</p>
      </div>),
    };
});
