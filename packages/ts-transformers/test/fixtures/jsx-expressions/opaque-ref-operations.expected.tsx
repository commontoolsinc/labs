import * as __ctHelpers from "commontools";
import { cell, recipe, UI } from "commontools";
export default recipe("OpaqueRefOperations", (_state) => {
    const count = cell(10);
    const price = cell(10);
    return {
        [UI]: (<div>
        <p>Count: {count}</p>
        <p>Next: {__ctHelpers.derive({
            type: "object",
            properties: {
                count: {
                    type: "number",
                    asCell: true
                }
            },
            required: ["count"]
        } as const satisfies __ctHelpers.JSONSchema, true as const satisfies __ctHelpers.JSONSchema, { count: count }, ({ count }) => count + 1)}</p>
        <p>Double: {__ctHelpers.derive({
            type: "object",
            properties: {
                count: {
                    type: "number",
                    asCell: true
                }
            },
            required: ["count"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { count: count }, ({ count }) => count * 2)}</p>
        <p>Total: {__ctHelpers.derive({
            type: "object",
            properties: {
                price: {
                    type: "number",
                    asCell: true
                }
            },
            required: ["price"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { price: price }, ({ price }) => price * 1.1)}</p>
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;

