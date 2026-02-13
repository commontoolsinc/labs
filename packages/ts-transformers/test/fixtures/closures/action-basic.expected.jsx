import * as __ctHelpers from "commontools";
import { Cell, pattern, action } from "commontools";
interface State {
    count: Cell<number>;
}
export default pattern({
    type: "object",
    properties: {
        count: {
            type: "number",
            asCell: true
        }
    },
    required: ["count"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        inc: {
            asStream: true
        }
    },
    required: ["inc"]
} as const satisfies __ctHelpers.JSONSchema, ({ count }) => {
    return {
        inc: __ctHelpers.handler(false as const satisfies __ctHelpers.JSONSchema, {
            type: "object",
            properties: {
                count: {
                    type: "number",
                    asCell: true
                }
            },
            required: ["count"]
        } as const satisfies __ctHelpers.JSONSchema, (_, { count }) => count.set(count.get() + 1))({
            count: count
        }),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
