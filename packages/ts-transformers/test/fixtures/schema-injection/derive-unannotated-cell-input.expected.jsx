function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { derive, type Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// FIXTURE: derive-unannotated-cell-input
// Verifies: the lowerDeriveCall typeRegistry override (lift/transformer.ts)
// preserves the asCell wrapper when a cell-like input flows into an
// UNANNOTATED callback param whose body uses no independent cell signal
// (no equals()/.equals()/.get()). The override pins the param's type to the
// input's widened type so schema injection emits asCell on the input schema.
//
// If the override is removed, the checker resolves the unannotated `state`
// param to the unwrapped value and the injected input schema loses
// `asCell: ["readonly"]` — the one line below changes.
//
// Note the param is intentionally UNANNOTATED and the body uses `===` (an
// identity comparison that carries no cell-detection signal). Annotating the
// param or calling .get()/equals() would re-establish cell-ness independently
// and mask the override.
const state = __cfHelpers.__cf_data({} as (Writable<number> | undefined));
const same = __cfHelpers.__cf_data(__cfHelpers.lift({
    type: ["number", "undefined"],
    asCell: ["readonly"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, (state) => state === state)(state).for("same", true));
export default __cfHelpers.__cf_data({
    same,
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
