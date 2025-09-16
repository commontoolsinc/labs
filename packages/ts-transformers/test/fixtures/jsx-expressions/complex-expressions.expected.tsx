/// <cts-enable />
import { cell, derive, h, recipe, UI, JSONSchema } from "commontools";
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
} as const satisfies JSONSchema, ({ price, discount, tax }) => {
    return {
        [UI]: (<div>
        <p>Price: {price}</p>
        <p>Discount: {commontools_1.derive({ price, discount }, ({ price: price, discount: discount }) => price - discount)}</p>
        <p>With tax: {commontools_1.derive({ price, discount, tax }, ({ price: price, discount: discount, tax: tax }) => (price - discount) * (1 + tax))}</p>
      </div>)
    };
});

