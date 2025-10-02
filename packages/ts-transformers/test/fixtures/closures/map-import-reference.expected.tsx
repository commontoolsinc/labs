/// <cts-enable />
import { h, recipe, UI, JSONSchema } from "commontools";
// Module-level constant
const TAX_RATE = 0.08;
// Imported utility function (simulated)
function formatPrice(price: number): string {
    return `$${price.toFixed(2)}`;
}
interface Item {
    id: number;
    price: number;
}
interface State {
    items: Item[];
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
        }
    },
    required: ["items"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "number"
                },
                price: {
                    type: "number"
                }
            },
            required: ["id", "price"]
        }
    }
} as const satisfies JSONSchema, (state) => {
    return {
        [UI]: (<div>
        {/* Captures module-level constant and function */}
        {state.items.map(recipe(({ elem, params: { formatPrice, TAX_RATE } }) => (<div>
            Item: {formatPrice(elem.price * (1 + TAX_RATE))}
          </div>)), { formatPrice: formatPrice, TAX_RATE: TAX_RATE })}
      </div>),
    };
});
