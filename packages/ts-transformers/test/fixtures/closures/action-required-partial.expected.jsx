import * as __cfHelpers from "commonfabric";
import { Cell, pattern, action } from "commonfabric";
interface BaseState {
    a?: Cell<string>;
    b: Cell<number>;
}
// Required<BaseState> should make 'a' required in the schema
type ReqState = Required<BaseState>;
// FIXTURE: action-required-partial
// Verifies: Required<BaseState> makes originally-optional properties required in capture schemas
//   action(() => a.set("hello")) → handler(false, { a: { type: "string", asCell, required } }, ...)({ a })
// Context: BaseState.a is optional, but Required<> forces it to required in both input and capture schemas
export default pattern((__ct_pattern_input) => {
    const a = __ct_pattern_input.key("a");
    const b = __ct_pattern_input.key("b");
    return {
        setA: __cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
            type: "object",
            properties: {
                a: {
                    type: "string",
                    asCell: true
                }
            },
            required: ["a"]
        } as const satisfies __cfHelpers.JSONSchema, (_, { a }) => a.set("hello"))({
            a: a
        }),
        setB: __cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
            type: "object",
            properties: {
                b: {
                    type: "number",
                    asCell: true
                }
            },
            required: ["b"]
        } as const satisfies __cfHelpers.JSONSchema, (_, { b }) => b.set(42))({
            b: b
        }),
    };
}, {
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
} as const satisfies __cfHelpers.JSONSchema, {
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
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
