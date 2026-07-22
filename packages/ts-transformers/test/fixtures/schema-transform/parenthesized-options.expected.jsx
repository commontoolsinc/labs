function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { toSchema } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Config {
    count: number;
    label: string;
}
const configSchema = __cfHelpers.__cf_data({
    type: "object",
    properties: {
        count: {
            type: "number"
        },
        label: {
            type: "string"
        }
    },
    required: ["count", "label"],
    description: "a description",
    "default": {
        count: 1,
        label: "text"
    },
    examples: ["one", 2]
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: parenthesized-options
// Verifies: a parenthesized value in the toSchema options object survives,
// whatever its type. Each of these properties was silently dropped before --
// including plainly non-numeric ones, which is why the unwrapping belongs in
// the options evaluator rather than in its numeric special case.
export { configSchema };
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
