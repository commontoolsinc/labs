function __ctHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
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
          <p>Discount: {__cfHelpers.derive({
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
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, {
            price: price,
            discount: discount
        }, ({ price, discount }) => price - discount)}</p>
          <p>With tax: {__cfHelpers.derive({
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
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, {
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
} as const satisfies __cfHelpers.JSONSchema, {
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
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__ctHardenFn(h);
