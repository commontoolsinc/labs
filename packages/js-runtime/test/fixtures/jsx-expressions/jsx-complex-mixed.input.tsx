/// <cts-enable />
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

export default recipe<State>("ComplexMixed", (state) => {
  return {
    [UI]: (
      <div>
        <h3>Array Operations</h3>
        <p>Total items: {state.items.length}</p>
        <p>Filtered count: {state.items.filter(i => i.name.includes(state.filter)).length}</p>
        
        <h3>Array with Complex Expressions</h3>
        <ul>
          {state.items.map(item => (
            <li key={item.id}>
              <span>{item.name}</span>
              <span> - Original: ${item.price}</span>
              <span> - Discounted: ${(item.price * (1 - state.discount)).toFixed(2)}</span>
              <span> - With tax: ${(item.price * (1 - state.discount) * (1 + state.taxRate)).toFixed(2)}</span>
            </li>
          ))}
        </ul>
        
        <h3>Array Methods</h3>
        <p>Item count: {state.items.length}</p>
        <p>Active items: {state.items.filter(i => i.active).length}</p>
        
        <h3>Simple Operations</h3>
        <p>Discount percent: {state.discount * 100}%</p>
        <p>Tax percent: {state.taxRate * 100}%</p>
        
        <h3>Array Predicates</h3>
        <p>All active: {state.items.every(i => i.active) ? "Yes" : "No"}</p>
        <p>Any active: {state.items.some(i => i.active) ? "Yes" : "No"}</p>
        <p>Has expensive (gt 100): {state.items.some(i => i.price > 100) ? "Yes" : "No"}</p>
        
        <h3>Object Operations</h3>
        <div data-item-count={state.items.length}
             data-has-filter={state.filter.length > 0}
             data-discount={state.discount}>
          Object attributes
        </div>
      </div>
    ),
  };
});