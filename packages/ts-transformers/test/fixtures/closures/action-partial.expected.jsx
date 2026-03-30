import * as __ctHelpers from "commontools";
import { Cell, pattern, action } from "commontools";
interface BaseState {
    a: Cell<string>;
    b: Cell<number>;
}
// Partial<BaseState> should make both 'a' and 'b' optional in the schema
type PartState = Partial<BaseState>;
// FIXTURE: action-partial
// Verifies: Partial<BaseState> produces optional (anyOf undefined|type) capture schemas in handlers
//   action(() => console.log(a)) → handler(false, { a: { anyOf: [undefined, string] } }, ...)({ a })
// Context: Partial<> makes properties optional; capture schemas reflect this with anyOf union
export default pattern((__ct_pattern_input) => {
    const a = __ct_pattern_input.key("a");
    const b = __ct_pattern_input.key("b");
    return {
        readA: __ctHelpers.handler(false as const satisfies __ctHelpers.JSONSchema, {
            type: "object",
            properties: {
                a: {
                    type: "string",
                    asCell: true
                }
            }
        } as const satisfies __ctHelpers.JSONSchema, (_, { a }) => console.log(a))({
            a: a
        }),
        readB: __ctHelpers.handler(false as const satisfies __ctHelpers.JSONSchema, {
            type: "object",
            properties: {
                b: {
                    type: "number",
                    asCell: true
                }
            }
        } as const satisfies __ctHelpers.JSONSchema, (_, { b }) => console.log(b))({
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
    }
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        readA: {
            asStream: true
        },
        readB: {
            asStream: true
        }
    },
    required: ["readA", "readB"]
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
