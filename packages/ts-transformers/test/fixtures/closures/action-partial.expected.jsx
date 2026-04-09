function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Cell, pattern, action } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
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
export default pattern((__cf_pattern_input) => {
    const a = __cf_pattern_input.key("a");
    const b = __cf_pattern_input.key("b");
    return {
        readA: __cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
            type: "object",
            properties: {
                a: {
                    type: "string",
                    asCell: ["cell"]
                }
            }
        } as const satisfies __cfHelpers.JSONSchema, (_, { a }) => console.log(a))({
            a: a
        }),
        readB: __cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
            type: "object",
            properties: {
                b: {
                    type: "number",
                    asCell: ["cell"]
                }
            }
        } as const satisfies __cfHelpers.JSONSchema, (_, { b }) => console.log(b))({
            b: b
        }),
    };
}, {
    type: "object",
    properties: {
        a: {
            type: "string",
            asCell: ["cell"]
        },
        b: {
            type: "number",
            asCell: ["cell"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        readA: {
            asCell: ["stream", "opaque"]
        },
        readB: {
            asCell: ["stream", "opaque"]
        }
    },
    required: ["readA", "readB"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
