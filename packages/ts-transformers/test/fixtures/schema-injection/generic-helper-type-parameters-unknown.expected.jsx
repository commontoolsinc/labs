function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Cell, generateObject, wish } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// FIXTURE: generic-helper-type-parameters-unknown
// Verifies: generic definition-site helper wrappers degrade injected schemas to unknown
//   wish<T>({ query }) → wish<T>({ query }, { type: "unknown" })
//   generateObject<T>({ ... }) → generateObject<T>({ ..., schema: { type: "unknown" } })
//   new Cell<T>() → new Cell<T>(undefined, { type: "unknown" })
// Cell initials are schema defaults and must be compile-time static
// (CT-1880); a generic helper's runtime value arrives via `.set(...)`.
export function buildWishExplicit<T>(path: string) {
    return wish<T>({ query: path }, {
        type: "unknown"
    } as const satisfies __cfHelpers.JSONSchema);
}
__cfHardenFn(buildWishExplicit);
export function buildObjectExplicit<T>(prompt: string) {
    return generateObject<T>({
        model: "gpt-4o-mini",
        prompt,
        schema: {
            type: "unknown"
        } as const satisfies __cfHelpers.JSONSchema
    });
}
__cfHardenFn(buildObjectExplicit);
export function buildCellExplicit<T>(value: T) {
    const result = new Cell<T>(undefined, {
        type: "unknown"
    } as const satisfies __cfHelpers.JSONSchema).for("result", true);
    result.set(value);
    return result;
}
__cfHardenFn(buildCellExplicit);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
