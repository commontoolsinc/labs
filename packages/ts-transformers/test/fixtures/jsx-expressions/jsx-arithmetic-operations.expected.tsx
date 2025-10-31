import * as __ctHelpers from "commontools";
import { recipe, UI } from "commontools";
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
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    return {
        [UI]: (<div>
        <h3>Basic Arithmetic</h3>
        <p>Count + 1: {__ctHelpers.derive({ state: {
                count: state.count
            } }, state => state.count + 1)}</p>
        <p>Count - 1: {__ctHelpers.derive({ state: {
                count: state.count
            } }, state => state.count - 1)}</p>
        <p>Count * 2: {__ctHelpers.derive({ state: {
                count: state.count
            } }, state => state.count * 2)}</p>
        <p>Price / 2: {__ctHelpers.derive({ state: {
                price: state.price
            } }, state => state.price / 2)}</p>
        <p>Count % 3: {__ctHelpers.derive({ state: {
                count: state.count
            } }, state => state.count % 3)}</p>

        <h3>Complex Expressions</h3>
        <p>Discounted Price: {__ctHelpers.derive({ state: {
                price: state.price,
                discount: state.discount
            } }, state => state.price - (state.price * state.discount))}</p>
        <p>Total: {__ctHelpers.derive({ state: {
                price: state.price,
                quantity: state.quantity
            } }, state => state.price * state.quantity)}</p>
        <p>With Tax (8%): {__ctHelpers.derive({ state: {
                price: state.price,
                quantity: state.quantity
            } }, state => (state.price * state.quantity) * 1.08)}</p>
        <p>
          Complex: {__ctHelpers.derive({ state: {
                count: state.count,
                quantity: state.quantity,
                price: state.price,
                discount: state.discount
            } }, state => (state.count + state.quantity) * state.price -
            (state.price * state.discount))}
        </p>

        <h3>Multiple Same Ref</h3>
        <p>Count³: {__ctHelpers.derive({ state: {
                count: state.count
            } }, state => state.count * state.count * state.count)}</p>
        <p>Price Range: ${__ctHelpers.derive({ state: {
                price: state.price
            } }, state => state.price - 10)} - ${__ctHelpers.derive({ state: {
                price: state.price
            } }, state => state.price + 10)}</p>
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
