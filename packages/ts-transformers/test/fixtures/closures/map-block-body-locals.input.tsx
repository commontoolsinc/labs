/// <cts-enable />
import { recipe, UI } from "commontools";

interface Item {
  price: number;
  quantity: number;
}

interface State {
  items: Item[];
  taxRate: number;
}

export default recipe<State>("BlockBodyLocals", (state) => {
  return {
    [UI]: (
      <div>
        {state.items.map((item, index) => {
          // Local variable declared inside callback
          const subtotal = item.price * item.quantity;
          const localTax = subtotal * 0.1;

          // Should only capture state.taxRate, not subtotal or localTax
          return (
            <div key={index}>
              Subtotal: {subtotal}, Tax: {localTax + state.taxRate}
            </div>
          );
        })}
      </div>
    ),
  };
});
