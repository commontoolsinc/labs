import * as __ctHelpers from "commontools";
import { h, recipe, UI } from "commontools";
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
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
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
    $defs: {
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
        }
    }
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    return {
        [UI]: (<div>
        <h3>Array Operations</h3>
        <p>Total items: {state.items.length}</p>
        <p>Filtered count: {__ctHelpers.derive({ state_items: state.items, state_filter: state.filter }, ({ state_items: _v1, state_filter: _v2 }) => _v1.filter(i => i.name.includes(_v2)).length)}</p>
        
        <h3>Array with Complex Expressions</h3>
        <ul>
          {state.items.map(item => (<li key={item.id}>
              <span>{item.name}</span>
              <span> - Original: ${item.price}</span>
              <span> - Discounted: ${__ctHelpers.derive({ item_price: item.price, state_discount: state.discount }, ({ item_price: _v1, state_discount: _v2 }) => (_v1 * (1 - _v2)).toFixed(2))}</span>
              <span> - With tax: ${__ctHelpers.derive({ item_price: item.price, state_discount: state.discount, state_taxRate: state.taxRate }, ({ item_price: _v1, state_discount: _v2, state_taxRate: _v3 }) => (_v1 * (1 - _v2) * (1 + _v3)).toFixed(2))}</span>
            </li>))}
        </ul>
        
        <h3>Array Methods</h3>
        <p>Item count: {state.items.length}</p>
        <p>Active items: {__ctHelpers.derive(state.items, _v1 => _v1.filter(i => i.active).length)}</p>
        
        <h3>Simple Operations</h3>
        <p>Discount percent: {__ctHelpers.derive(state.discount, _v1 => _v1 * 100)}%</p>
        <p>Tax percent: {__ctHelpers.derive(state.taxRate, _v1 => _v1 * 100)}%</p>
        
        <h3>Array Predicates</h3>
        <p>All active: {__ctHelpers.ifElse(__ctHelpers.derive(state.items, _v1 => _v1.every(i => i.active)), "Yes", "No")}</p>
        <p>Any active: {__ctHelpers.ifElse(__ctHelpers.derive(state.items, _v1 => _v1.some(i => i.active)), "Yes", "No")}</p>
        <p>Has expensive (gt 100): {__ctHelpers.ifElse(__ctHelpers.derive(state.items, _v1 => _v1.some(i => i.price > 100)), "Yes", "No")}</p>
        
        <h3>Object Operations</h3>
        <div data-item-count={state.items.length} data-has-filter={__ctHelpers.derive(state.filter.length, _v1 => _v1 > 0)} data-discount={state.discount}>
          Object attributes
        </div>
      </div>),
    };
});
__ctHelpers.NAME; // <internals>
