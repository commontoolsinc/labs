/// <cts-enable />
import { h, recipe, UI, JSONSchema } from "commontools";
interface Item {
    price: number;
    quantity: number;
}
interface State {
    items: Item[];
    discount: number;
    taxRate: number;
}
const shippingCost = 5.99;
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
        discount: {
            type: "number"
        },
        taxRate: {
            type: "number"
        }
    },
    required: ["items", "discount", "taxRate"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                price: {
                    type: "number"
                },
                quantity: {
                    type: "number"
                }
            },
            required: ["price", "quantity"]
        }
    }
} as const satisfies JSONSchema, (state) => {
    const multiplier = 2;
    return {
        [UI]: (<div>
        {state.items.map(recipe(({ elem, params: { discount, taxRate, multiplier, shippingCost } }) => (<span>
            Total: {elem.price * elem.quantity * discount * taxRate * multiplier + shippingCost}
          </span>)), { discount: state.discount, taxRate: state.taxRate, multiplier: multiplier, shippingCost: shippingCost })}
      </div>),
    };
});
