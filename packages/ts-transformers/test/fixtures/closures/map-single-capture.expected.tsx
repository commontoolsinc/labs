/// <cts-enable />
import { h, recipe, UI, JSONSchema } from "commontools";
interface State {
    items: Array<{
        price: number;
    }>;
    discount: number;
}
export default recipe({
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    price: {
                        type: "number"
                    }
                },
                required: ["price"]
            }
        },
        discount: {
            type: "number"
        }
    },
    required: ["items", "discount"]
} as const satisfies JSONSchema, (state) => {
    return {
        [UI]: (<div>
        {state.items.map_with_pattern(recipe({
                type: "object",
                properties: {
                    elem: {
                        type: "object",
                        properties: {
                            price: {
                                type: "number"
                            }
                        },
                        required: ["price"]
                    },
                    params: {
                        type: "object",
                        properties: {
                            discount: {
                                type: "number",
                                asOpaque: true
                            }
                        },
                        required: ["discount"]
                    }
                },
                required: ["elem", "params"]
            } as const satisfies JSONSchema, ({ elem, params: { discount } }) => (<span>{elem.price * discount}</span>)), { discount: state.discount })}
      </div>),
    };
});