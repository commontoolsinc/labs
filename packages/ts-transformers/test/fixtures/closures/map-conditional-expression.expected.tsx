/// <cts-enable />
import { h, recipe, UI, JSONSchema } from "commontools";
interface Item {
    id: number;
    price: number;
}
interface State {
    items: Item[];
    discount: number;
    threshold: number;
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
        discount: {
            type: "number"
        },
        threshold: {
            type: "number"
        }
    },
    required: ["items", "discount", "threshold"],
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
        {/* Ternary with captures in map callback */}
        {state.items.map_with_pattern(recipe("map with pattern including captures", ({ elem, params: { threshold, discount } }) => (<div>
            Price: ${elem.price > threshold
                    ? elem.price * (1 - discount)
                    : elem.price}
          </div>)), { threshold: state.threshold, discount: state.discount })}
      </div>),
    };
});
