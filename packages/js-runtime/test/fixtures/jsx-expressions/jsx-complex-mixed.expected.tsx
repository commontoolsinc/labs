/// <cts-enable />
import { h, recipe, UI, ifElse, derive, JSONSchema } from "commontools";
interface Item {
    id: number;
    name: string;
    price: number;
    active: boolean;
}
interface State {
    items: Item[];
    filter: string;
    discount: number;
    taxRate: number;
}
export default recipe({
    $schema: "https://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/definitions/Item"
            }
        },
        filter: {
            type: "string"
        },
        discount: {
            type: "number"
        },
        taxRate: {
            type: "number"
        }
    },
    required: ["items", "filter", "discount", "taxRate"],
    definitions: {
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "number"
                },
                name: {
                    type: "string"
                },
                price: {
                    type: "number"
                },
                active: {
                    type: "boolean"
                }
            },
            required: ["id", "name", "price", "active"]
        },
        State: {
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        $ref: "#/definitions/Item"
                    }
                },
                filter: {
                    type: "string"
                },
                discount: {
                    type: "number"
                },
                taxRate: {
                    type: "number"
                }
            },
            required: ["items", "filter", "discount", "taxRate"]
        }
    }
} as const satisfies JSONSchema, (state) => {
    return {
        [UI]: (<div>
        <h3>Array Operations</h3>
        <p>Total items: {commontools_1.derive(state.items, _v1 => _v1.length)}</p>
        <p>Filtered count: {commontools_1.derive({ state_items: state.items, state_filter: state.filter }, ({ state_items: _v1, state_filter: _v2 }) => _v1.filter(i => i.name.includes(_v2)).length)}</p>
        
        <h3>Array with Complex Expressions</h3>
        <ul>
          {state.items.map(item => (<li key={item.id}>
              <span>{item.name}</span>
              <span> - Original: ${item.price}</span>
              <span> - Discounted: ${commontools_1.derive(state.discount, _v1 => (item.price * (1 - _v1)).toFixed(2))}</span>
              <span> - With tax: ${commontools_1.derive({ state_discount: state.discount, state_taxRate: state.taxRate }, ({ state_discount: _v1, state_taxRate: _v2 }) => (item.price * (1 - _v1) * (1 + _v2)).toFixed(2))}</span>
            </li>))}
        </ul>
        
        <h3>Array Methods</h3>
        <p>Item count: {commontools_1.derive(state.items, _v1 => _v1.length)}</p>
        <p>Active items: {commontools_1.derive(state.items, _v1 => _v1.filter(i => i.active).length)}</p>
        
        <h3>Simple Operations</h3>
        <p>Discount percent: {commontools_1.derive(state.discount, _v1 => _v1 * 100)}%</p>
        <p>Tax percent: {commontools_1.derive(state.taxRate, _v1 => _v1 * 100)}%</p>
        
        <h3>Array Predicates</h3>
        <p>All active: {commontools_1.ifElse(commontools_1.derive(state.items, _v1 => _v1.every(i => i.active)), "Yes", "No")}</p>
        <p>Any active: {commontools_1.ifElse(commontools_1.derive(state.items, _v1 => _v1.some(i => i.active)), "Yes", "No")}</p>
        <p>Has expensive (gt 100): {commontools_1.ifElse(commontools_1.derive(state.items, _v1 => _v1.some(i => i.price > 100)), "Yes", "No")}</p>
        
        <h3>Object Operations</h3>
        <div data-item-count={commontools_1.derive(state.items, _v1 => _v1.length)} data-has-filter={commontools_1.derive(state.filter, _v1 => _v1.length > 0)} data-discount={state.discount}>
          Object attributes
        </div>
      </div>),
    };
});
