import * as __ctHelpers from "commontools";
import { recipe, UI } from "commontools";
interface Problem {
    price: number;
    discount: number;
    tax: number;
}
export default recipe({
    type: "object",
    properties: {
        price: {
            type: "number"
        },
        discount: {
            type: "number"
        },
        tax: {
            type: "number"
        }
    },
    required: ["price", "discount", "tax"]
} as const satisfies __ctHelpers.JSONSchema, ({ price, discount, tax }) => {
    return {
        [UI]: (<div>
          <p>Price: {price}</p>
          <p>Discount: {__ctHelpers.derive({ price, discount }, ({ price: price, discount: discount }) => price - discount)}</p>
          <p>With tax: {__ctHelpers.derive({ price, discount, tax }, ({ price: price, discount: discount, tax: tax }) => (price - discount) * (1 + tax))}</p>
        </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
