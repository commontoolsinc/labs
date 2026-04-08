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
interface State {
    count: Cell<number>;
}
// FIXTURE: action-basic
// Verifies: action() callback is extracted into a handler with captured state
//   action(() => count.set(...)) → handler(eventSchema, captureSchema, (_, { count }) => count.set(...))({ count })
export default pattern((__cf_pattern_input) => {
    const count = __cf_pattern_input.key("count");
    return {
        inc: __cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
            type: "object",
            properties: {
                count: {
                    type: "number",
                    asCell: true
                }
            },
            required: ["count"]
        } as const satisfies __cfHelpers.JSONSchema, (_, { count }) => count.set(count.get() + 1))({
            count: count
        }),
    };
}, {
    type: "object",
    properties: {
        count: {
            type: "number",
            asCell: true
        }
    },
    required: ["count"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        inc: {
            asStream: true
        }
    },
    required: ["inc"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
