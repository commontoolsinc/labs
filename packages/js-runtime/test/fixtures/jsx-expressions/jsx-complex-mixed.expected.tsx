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
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
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
} as const satisfies JSONSchema, (state) => {
    return {
        [UI]: (<div>
        <h3>Array Operations</h3>
        <p>Total items: {(globalThis.__CT_COMMONTOOLS).derive(state.items, _v1 => _v1.length)}</p>
        <p>Filtered count: {(globalThis.__CT_COMMONTOOLS).derive({ state_items: state.items, state_filter: state.filter }, ({ state_items: _v1, state_filter: _v2 }) => _v1.filter(i => i.name.includes(_v2)).length)}</p>
        
        <h3>Array with Complex Expressions</h3>
        <ul>
          {state.items.map(item => (<li key={item.id}>
              <span>{item.name}</span>
              <span> - Original: ${item.price}</span>
              <span> - Discounted: ${(globalThis.__CT_COMMONTOOLS).derive(state.discount, _v1 => (item.price * (1 - _v1)).toFixed(2))}</span>
              <span> - With tax: ${(globalThis.__CT_COMMONTOOLS).derive({ state_discount: state.discount, state_taxRate: state.taxRate }, ({ state_discount: _v1, state_taxRate: _v2 }) => (item.price * (1 - _v1) * (1 + _v2)).toFixed(2))}</span>
            </li>))}
        </ul>
        
        <h3>Array Methods</h3>
        <p>Item count: {(globalThis.__CT_COMMONTOOLS).derive(state.items, _v1 => _v1.length)}</p>
        <p>Active items: {(globalThis.__CT_COMMONTOOLS).derive(state.items, _v1 => _v1.filter(i => i.active).length)}</p>
        
        <h3>Simple Operations</h3>
        <p>Discount percent: {(globalThis.__CT_COMMONTOOLS).derive(state.discount, _v1 => _v1 * 100)}%</p>
        <p>Tax percent: {(globalThis.__CT_COMMONTOOLS).derive(state.taxRate, _v1 => _v1 * 100)}%</p>
        
        <h3>Array Predicates</h3>
        <p>All active: {(globalThis.__CT_COMMONTOOLS).ifElse((globalThis.__CT_COMMONTOOLS).derive(state.items, _v1 => _v1.every(i => i.active)), "Yes", "No")}</p>
        <p>Any active: {(globalThis.__CT_COMMONTOOLS).ifElse((globalThis.__CT_COMMONTOOLS).derive(state.items, _v1 => _v1.some(i => i.active)), "Yes", "No")}</p>
        <p>Has expensive (gt 100): {(globalThis.__CT_COMMONTOOLS).ifElse((globalThis.__CT_COMMONTOOLS).derive(state.items, _v1 => _v1.some(i => i.price > 100)), "Yes", "No")}</p>
        
        <h3>Object Operations</h3>
        <div data-item-count={(globalThis.__CT_COMMONTOOLS).derive(state.items, _v1 => _v1.length)} data-has-filter={(globalThis.__CT_COMMONTOOLS).derive(state.filter, _v1 => _v1.length > 0)} data-discount={state.discount}>
          Object attributes
        </div>
      </div>),
    };
});

