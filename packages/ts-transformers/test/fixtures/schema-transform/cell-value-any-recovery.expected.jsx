function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { cell } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
declare function fetchAny(): any;
// FIXTURE: cell-value-any-recovery
// Verifies: `any`-typed cells emit a permissive `true` schema.
// Cell initials are schema defaults and must be compile-time static
// (CT-1880), so the runtime value arrives via `.set(...)` and the `any`
// comes from the explicit type argument.
export const value = __cfHelpers.__cf_data(cell<any>(undefined, true as const satisfies __cfHelpers.JSONSchema).for("value", true));
value.set(fetchAny());
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
