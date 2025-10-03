/// <cts-enable />
import { h, recipe, UI, derive, ifElse, JSONSchema } from "commontools";
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
} as const satisfies JSONSchema, (state) => {
    return {
        [UI]: (<div>
        <h3>Array Operations</h3>
        <p>Total items: {state.items.length}</p>
        <p>Filtered count: {derive({ state_items: state.items, state_filter: state.filter }, ({ state_items: _v1, state_filter: _v2 }) => _v1.filter(i => i.name.includes(_v2)).length)}</p>
        
        <h3>Array with Complex Expressions</h3>
        <ul>
          {state.items.map_with_pattern(recipe("map with pattern including captures", ({ elem, params: { discount, taxRate } }) => (<li key={elem.id}>
              <span>{elem.name}</span>
              <span> - Original: ${elem.price}</span>
              <span> - Discounted: ${(elem.price * (1 - discount)).toFixed(2)}</span>
              <span> - With tax: ${(elem.price * (1 - discount) * (1 + taxRate)).toFixed(2)}</span>
            </li>)), { discount: state.discount, taxRate: state.taxRate })}
        </ul>
        
        <h3>Array Methods</h3>
        <p>Item count: {state.items.length}</p>
        <p>Active items: {derive(state.items, _v1 => _v1.filter(i => i.active).length)}</p>
        
        <h3>Simple Operations</h3>
        <p>Discount percent: {derive(state.discount, _v1 => _v1 * 100)}%</p>
        <p>Tax percent: {derive(state.taxRate, _v1 => _v1 * 100)}%</p>
        
        <h3>Array Predicates</h3>
        <p>All active: {ifElse(derive(state.items, _v1 => _v1.every(i => i.active)), "Yes", "No")}</p>
        <p>Any active: {ifElse(derive(state.items, _v1 => _v1.some(i => i.active)), "Yes", "No")}</p>
        <p>Has expensive (gt 100): {ifElse(derive(state.items, _v1 => _v1.some(i => i.price > 100)), "Yes", "No")}</p>
        
        <h3>Object Operations</h3>
        <div data-item-count={state.items.length} data-has-filter={derive(state.filter.length, _v1 => _v1 > 0)} data-discount={state.discount}>
          Object attributes
        </div>
      </div>),
    };
});
