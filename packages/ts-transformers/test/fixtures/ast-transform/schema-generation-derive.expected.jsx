function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { derive } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
type DeriveInput = {
    count: number;
};
type DeriveResult = {
    doubled: number;
};
declare const source: DeriveInput;
// FIXTURE: schema-generation-derive
// Verifies: derive() with generic type args generates input and output schemas
//   derive<DeriveInput, DeriveResult>(source, fn) → derive(inputSchema, outputSchema, source, fn)
export const doubledValue = derive({
    type: "object",
    properties: {
        count: {
            type: "number"
        }
    },
    required: ["count"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        doubled: {
            type: "number"
        }
    },
    required: ["doubled"]
} as const satisfies __cfHelpers.JSONSchema, source, (input) => ({
    doubled: input.count * 2,
}));
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
