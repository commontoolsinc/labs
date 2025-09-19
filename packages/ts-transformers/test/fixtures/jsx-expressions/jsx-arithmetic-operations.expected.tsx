/// <cts-enable />
import { h, recipe, UI, derive, JSONSchema } from "commontools";
interface State {
    count: number;
    price: number;
    discount: number;
    quantity: number;
}
export default recipe({
    type: "object",
    properties: {
        count: {
            type: "number"
        },
        price: {
            type: "number"
        },
        discount: {
            type: "number"
        },
        quantity: {
            type: "number"
        }
    },
    required: ["count", "price", "discount", "quantity"]
} as const satisfies JSONSchema, (state) => {
    return {
        [UI]: (<div>
        <h3>Basic Arithmetic</h3>
        <p>Count + 1: {derive(state.count, _v1 => _v1 + 1)}</p>
        <p>Count - 1: {derive(state.count, _v1 => _v1 - 1)}</p>
        <p>Count * 2: {derive(state.count, _v1 => _v1 * 2)}</p>
        <p>Price / 2: {derive(state.price, _v1 => _v1 / 2)}</p>
        <p>Count % 3: {derive(state.count, _v1 => _v1 % 3)}</p>
        
        <h3>Complex Expressions</h3>
        <p>Discounted Price: {derive({ state_price: state.price, state_discount: state.discount }, ({ state_price: _v1, state_discount: _v2 }) => _v1 - (_v1 * _v2))}</p>
        <p>Total: {derive({ state_price: state.price, state_quantity: state.quantity }, ({ state_price: _v1, state_quantity: _v2 }) => _v1 * _v2)}</p>
        <p>With Tax (8%): {derive({ state_price: state.price, state_quantity: state.quantity }, ({ state_price: _v1, state_quantity: _v2 }) => (_v1 * _v2) * 1.08)}</p>
        <p>Complex: {derive({ state_count: state.count, state_quantity: state.quantity, state_price: state.price, state_discount: state.discount }, ({ state_count: _v1, state_quantity: _v2, state_price: _v3, state_discount: _v4 }) => (_v1 + _v2) * _v3 - (_v3 * _v4))}</p>
        
        <h3>Multiple Same Ref</h3>
        <p>Count³: {derive(state.count, _v1 => _v1 * _v1 * _v1)}</p>
        <p>Price Range: ${derive(state.price, _v1 => _v1 - 10)} - ${derive(state.price, _v1 => _v1 + 10)}</p>
      </div>),
    };
});
