import * as __ctHelpers from "commontools";
import { Cell, pattern, action } from "commontools";
interface BaseState {
    a?: Cell<string>;
    b: Cell<number>;
}
// Required<BaseState> should make 'a' required in the schema
type ReqState = Required<BaseState>;
export default pattern({
    type: "object",
    properties: {
        a: {
            type: "string",
            asCell: true
        },
        b: {
            type: "number",
            asCell: true
        }
    },
    required: ["a", "b"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        setA: {
            asStream: true
        },
        setB: {
            asStream: true
        }
    },
    required: ["setA", "setB"]
} as const satisfies __ctHelpers.JSONSchema, ({ a, b }) => {
    return {
        setA: __ctHelpers.handler(false as const satisfies __ctHelpers.JSONSchema, {
            type: "object",
            properties: {
                a: {
                    type: "string",
                    asCell: true
                }
            },
            required: ["a"]
        } as const satisfies __ctHelpers.JSONSchema, (_, { a }) => a.set("hello"))({
            a: a
        }),
        setB: __ctHelpers.handler(false as const satisfies __ctHelpers.JSONSchema, {
            type: "object",
            properties: {
                b: {
                    type: "number",
                    asCell: true
                }
            },
            required: ["b"]
        } as const satisfies __ctHelpers.JSONSchema, (_, { b }) => b.set(42))({
            b: b
        }),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
