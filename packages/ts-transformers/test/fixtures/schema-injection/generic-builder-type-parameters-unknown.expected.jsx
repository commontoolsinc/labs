import * as __cfHelpers from "commonfabric";
import { handler, lift } from "commonfabric";
// FIXTURE: generic-builder-type-parameters-unknown
// Verifies: generic definition-site builder wrappers degrade builder schemas to unknown
//   lift<T, U>(fn) → lift({ type: "unknown" }, { type: "unknown" }, fn)
//   handler<E, S>(fn) → handler({ type: "unknown" }, { type: "unknown" }, fn)
export function buildLift<T, U>() {
    return lift({
        type: "unknown"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "unknown"
    } as const satisfies __cfHelpers.JSONSchema, (_value) => {
        throw new Error("not executed");
    });
}
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
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
