function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface State {
    count: number;
    price: number;
    discount: number;
    quantity: number;
}
const __cfLift_1 = __cfHelpers.__cf_data(__cfHelpers.exprLift("expr:+", {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, ([__cfExpr0, __cfExpr1]) => __cfExpr0 + __cfExpr1));
const __cfLift_2 = __cfHelpers.__cf_data(__cfHelpers.exprLift("expr:-", {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, ([__cfExpr0, __cfExpr1]) => __cfExpr0 - __cfExpr1));
const __cfLift_3 = __cfHelpers.__cf_data(__cfHelpers.exprLift("expr:*", {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, ([__cfExpr0, __cfExpr1]) => __cfExpr0 * __cfExpr1));
const __cfLift_4 = __cfHelpers.__cf_data(__cfHelpers.exprLift("expr:/", {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, ([__cfExpr0, __cfExpr1]) => __cfExpr0 / __cfExpr1));
const __cfLift_5 = __cfHelpers.__cf_data(__cfHelpers.exprLift("expr:%", {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, ([__cfExpr0, __cfExpr1]) => __cfExpr0 % __cfExpr1));
const __cfLift_6 = __cfHelpers.__cf_data(__cfHelpers.exprLift("expr:*", {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, ([__cfExpr0, __cfExpr1]) => __cfExpr0 * __cfExpr1));
const __cfLift_7 = __cfHelpers.__cf_data(__cfHelpers.exprLift("expr:-", {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, ([__cfExpr0, __cfExpr1]) => __cfExpr0 - __cfExpr1));
const __cfLift_8 = __cfHelpers.__cf_data(__cfHelpers.exprLift("expr:*", {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, ([__cfExpr0, __cfExpr1]) => __cfExpr0 * __cfExpr1));
const __cfLift_9 = __cfHelpers.__cf_data(__cfHelpers.exprLift("expr:*", {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, ([__cfExpr0, __cfExpr1]) => __cfExpr0 * __cfExpr1));
const __cfLift_10 = __cfHelpers.__cf_data(__cfHelpers.exprLift("expr:*", {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, ([__cfExpr0, __cfExpr1]) => __cfExpr0 * __cfExpr1));
const __cfLift_11 = __cfHelpers.__cf_data(__cfHelpers.exprLift("expr:+", {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, ([__cfExpr0, __cfExpr1]) => __cfExpr0 + __cfExpr1));
const __cfLift_12 = __cfHelpers.__cf_data(__cfHelpers.exprLift("expr:*", {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, ([__cfExpr0, __cfExpr1]) => __cfExpr0 * __cfExpr1));
const __cfLift_13 = __cfHelpers.__cf_data(__cfHelpers.exprLift("expr:*", {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, ([__cfExpr0, __cfExpr1]) => __cfExpr0 * __cfExpr1));
const __cfLift_14 = __cfHelpers.__cf_data(__cfHelpers.exprLift("expr:-", {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, ([__cfExpr0, __cfExpr1]) => __cfExpr0 - __cfExpr1));
const __cfLift_15 = __cfHelpers.__cf_data(__cfHelpers.exprLift("expr:*", {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, ([__cfExpr0, __cfExpr1]) => __cfExpr0 * __cfExpr1));
const __cfLift_16 = __cfHelpers.__cf_data(__cfHelpers.exprLift("expr:*", {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, ([__cfExpr0, __cfExpr1]) => __cfExpr0 * __cfExpr1));
const __cfLift_17 = __cfHelpers.__cf_data(__cfHelpers.exprLift("expr:-", {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, ([__cfExpr0, __cfExpr1]) => __cfExpr0 - __cfExpr1));
const __cfLift_18 = __cfHelpers.__cf_data(__cfHelpers.exprLift("expr:+", {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, ([__cfExpr0, __cfExpr1]) => __cfExpr0 + __cfExpr1));
// FIXTURE: jsx-arithmetic-operations
// Verifies: arithmetic expressions with reactive refs in JSX are wrapped in a lift-applied computation
//   {state.count + 1}                      → lift(({state}) => state.count + 1)({ count })
//   {state.price * state.quantity * 1.08}   → lift(...)({ price, quantity })
//   {state.count * state.count * state.count} → lift(...)({ count })
export default pattern((state) => {
    return {
        [UI]: (<div>
        <h3>Basic Arithmetic</h3>
        <p>Count + 1: {__cfLift_1([state.key("count"), 1])}</p>
        <p>Count - 1: {__cfLift_2([state.key("count"), 1])}</p>
        <p>Count * 2: {__cfLift_3([state.key("count"), 2])}</p>
        <p>Price / 2: {__cfLift_4([state.key("price"), 2])}</p>
        <p>Count % 3: {__cfLift_5([state.key("count"), 3])}</p>

        <h3>Complex Expressions</h3>
        <p>Discounted Price: {__cfLift_7([state.key("price"), (__cfLift_6([state.key("price"), state.key("discount")]))])}</p>
        <p>Total: {__cfLift_8([state.key("price"), state.key("quantity")])}</p>
        <p>With Tax (8%): {__cfLift_10([(__cfLift_9([state.key("price"), state.key("quantity")])), 1.08])}</p>
        <p>
          Complex: {__cfLift_14([__cfLift_12([(__cfLift_11([state.key("count"), state.key("quantity")])), state.key("price")]), (__cfLift_13([state.key("price"), state.key("discount")]))])}
        </p>

        <h3>Multiple Same Ref</h3>
        <p>Count³: {__cfLift_16([__cfLift_15([state.key("count"), state.key("count")]), state.key("count")])}</p>
        <p>Price Range: ${__cfLift_17([state.key("price"), 10])} - ${__cfLift_18([state.key("price"), 10])}</p>
      </div>),
    };
}, {
    type: "object",
    properties: {
        count: {
            type: "number"
        },
        price: {
            type: "number"
        },
        discount: {
            type: "number"
        },
        quantity: {
            type: "number"
        }
    },
    required: ["count", "price", "discount", "quantity"]
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
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfLift_2,
    __cfLift_3,
    __cfLift_4,
    __cfLift_5,
    __cfLift_6,
    __cfLift_7,
    __cfLift_8,
    __cfLift_9,
    __cfLift_10,
    __cfLift_11,
    __cfLift_12,
    __cfLift_13,
    __cfLift_14,
    __cfLift_15,
    __cfLift_16,
    __cfLift_17,
    __cfLift_18
});
