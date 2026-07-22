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
    sentinel: number;
    ratio: number;
    nan: number;
    inf: number;
    ninf: number;
    nzero: number;
    parenthesized: number;
}
const configSchema = __cfHelpers.__cf_data({
    type: "object",
    properties: {
        sentinel: {
            type: "number"
        },
        ratio: {
            type: "number"
        },
        nan: {
            type: "number"
        },
        inf: {
            type: "number"
        },
        ninf: {
            type: "number"
        },
        nzero: {
            type: "number"
        },
        parenthesized: {
            type: "number"
        }
    },
    required: ["sentinel", "ratio", "nan", "inf", "ninf", "nzero", "parenthesized"],
    "default": {
        sentinel: -1,
        ratio: -0.5,
        nan: NaN,
        inf: Infinity,
        ninf: -Infinity,
        nzero: -0,
        parenthesized: -1
    },
    description: "a description"
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: numeric-option-defaults
// Verifies: the toSchema options object carries signed and non-finite numbers
// through to the emitted schema, and sees through parentheses. Recognizing only
// bare NumericLiteral drops each of these properties silently — a `-1` sentinel
// default just vanishes — and a value in parentheses is dropped whatever its
// type, which is why a plain string is among the cases here.
export { configSchema };
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
