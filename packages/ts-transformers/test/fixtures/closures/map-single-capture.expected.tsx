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
        {state.items.map(recipe(({ elem, params: { discount } }) => (<span>{elem.price * discount}</span>)), { discount: state.discount })}
      </div>),
    };
});