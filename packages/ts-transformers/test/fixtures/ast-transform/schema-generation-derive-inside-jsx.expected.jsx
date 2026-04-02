function __ctHardenFn(fn: Function) {
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
declare const value: number;
// FIXTURE: schema-generation-derive-inside-jsx
// Verifies: derive() inside a JSX expression still gets schemas injected
//   derive(value, (v) => v * 2) → derive(inputSchema, outputSchema, value, fn)
// Context: derive() appears as a JSX child expression, not a standalone statement
export const result = (<div>
    {derive({
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, value, (v) => v * 2)}
  </div>);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__ctHardenFn(h);
