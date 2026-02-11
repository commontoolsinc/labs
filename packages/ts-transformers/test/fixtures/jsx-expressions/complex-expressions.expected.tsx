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
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "#/$defs/JSXElement"
        }
    },
    required: ["$UI"],
    $defs: {
        JSXElement: {
            anyOf: [{
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }, {
                    type: "object",
                    properties: {}
                }, {
                    $ref: "#/$defs/UIRenderable",
                    asOpaque: true
                }]
        },
        UIRenderable: {
            type: "object",
            properties: {
                $UI: {
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }
            },
            required: ["$UI"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, ({ price, discount, tax }) => {
    return {
        [UI]: (<div>
          <p>Price: {price}</p>
          <p>Discount: {__ctHelpers.derive({
            type: "object",
            properties: {
                price: {
                    type: "number",
                    asOpaque: true
                },
                discount: {
                    type: "number",
                    asOpaque: true
                }
            },
            required: ["price", "discount"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, {
            price: price,
            discount: discount
        }, ({ price, discount }) => price - discount)}</p>
          <p>With tax: {__ctHelpers.derive({
            type: "object",
            properties: {
                price: {
                    type: "number",
                    asOpaque: true
                },
                discount: {
                    type: "number",
                    asOpaque: true
                },
                tax: {
                    type: "number",
                    asOpaque: true
                }
            },
            required: ["price", "discount", "tax"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, {
            price: price,
            discount: discount,
            tax: tax
        }, ({ price, discount, tax }) => (price - discount) * (1 + tax))}</p>
        </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
