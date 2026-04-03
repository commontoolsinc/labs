function __ctHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { handler, lift } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
const __ctModuleCallback_1 = __ctHardenFn((_value) => {
    throw new Error("not executed");
});
// FIXTURE: generic-builder-type-parameters-unknown
// Verifies: generic definition-site builder wrappers degrade builder schemas to unknown
//   lift<T, U>(fn) → lift({ type: "unknown" }, { type: "unknown" }, fn)
//   handler<E, S>(fn) → handler({ type: "unknown" }, { type: "unknown" }, fn)
export function buildLift<T, U>() {
    return lift({
        type: "unknown"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "unknown"
    } as const satisfies __cfHelpers.JSONSchema, __ctModuleCallback_1);
}
__ctHardenFn(buildLift);
export function buildHandler<E, S>() {
    return handler({
        type: "unknown"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "unknown"
    } as const satisfies __cfHelpers.JSONSchema, (event, state) => {
        void event;
        void state;
    });
}
__ctHardenFn(buildHandler);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__ctHardenFn(h);
