function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { derive, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// FIXTURE: derive-captured-callable-export-binding
// Verifies: derive() should treat captured plain callables like no explicit
// captures and leave the helper lexical rather than merging it into the derive input.
function makePattern(helper: (value: string) => string) {
    return pattern(() => {
        return {
            label: derive(false as const satisfies __cfHelpers.JSONSchema, {
                type: "string"
            } as const satisfies __cfHelpers.JSONSchema, "x", () => helper("x")).for(["__patternResult", "label"], true)
        };
    }, false as const satisfies __cfHelpers.JSONSchema, {
        type: "object",
        properties: {
            label: {
                type: "string"
            }
        },
        required: ["label"]
    } as const satisfies __cfHelpers.JSONSchema);
}
__cfHardenFn(makePattern);
const helper = __cfHardenFn((value: string) => value.toUpperCase());
const myPattern = __cfHelpers.__cf_data(makePattern(helper));
export default myPattern;
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
