import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
interface Problem {
    price: number;
    discount: number;
    tax: number;
}
// FIXTURE: complex-expressions
// Verifies: multi-variable arithmetic in JSX is wrapped in derive() with captured refs
//   {price - discount}             → derive({price, discount}, (...) => price - discount)
//   {(price - discount) * (1+tax)} → derive({price, discount, tax}, (...) => ...)
export default pattern((__ct_pattern_input) => {
    const price = __ct_pattern_input.key("price");
    const discount = __ct_pattern_input.key("discount");
    const tax = __ct_pattern_input.key("tax");
    return {
        [UI]: (<div>
          <p>Price: {price}</p>
          <p>Discount: {__ctHelpers.derive({
            type: "object",
            properties: {
                price: {
                    type: "number"
                },
                discount: {
                    type: "number"
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
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, {
            price: price,
            discount: discount,
            tax: tax
        }, ({ price, discount, tax }) => (price - discount) * (1 + tax))}</p>
        </div>),
    };
}, {
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
                    $ref: "#/$defs/UIRenderable"
                }, {
                    type: "object",
                    properties: {}
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
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
