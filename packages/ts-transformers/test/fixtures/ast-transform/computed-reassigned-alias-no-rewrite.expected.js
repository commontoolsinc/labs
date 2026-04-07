function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { computed } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
// FIXTURE: computed-reassigned-alias-no-rewrite
// Verifies: mutable aliases to `computed()` are not treated as stable builder aliases.
let alias = computed;
alias = ((fn: () => number) => fn()) as typeof alias;
export default __cfHelpers.__ct_data(alias(() => 1));
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
