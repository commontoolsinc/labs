function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { computed as computedAlias } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
type AliasInput = {
    text: string;
};
type AliasResult = {
    length: number;
};
declare const state: AliasInput;
// FIXTURE: schema-generation-derive-alias
// Verifies: a reactive builder imported under an alias still gets schema injection
//   computedAlias((): AliasResult => ...) → captures `state` and lowers to lift(inputSchema, outputSchema, ...)
// Context: Uses `import { computed as computedAlias }` to test aliased import tracking
export const textLength = __cfHelpers.__cf_data(__cfHelpers.lift(false, (): AliasResult => ({
    length: state.text.length,
}))().for("textLength", true));
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
