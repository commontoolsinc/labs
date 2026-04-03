import * as __ctHelpers from "commontools";
import { handler, lift } from "commontools";
// FIXTURE: generic-builder-type-parameters-unknown
// Verifies: generic definition-site builder wrappers degrade builder schemas to unknown
//   lift<T, U>(fn) → lift({ type: "unknown" }, { type: "unknown" }, fn)
//   handler<E, S>(fn) → handler({ type: "unknown" }, { type: "unknown" }, fn)
export function buildLift<T, U>() {
    return lift({
        type: "unknown"
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "unknown"
    } as const satisfies __ctHelpers.JSONSchema, (_value) => {
        throw new Error("not executed");
    });
}
export function buildHandler<E, S>() {
    return handler({
        type: "unknown"
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "unknown"
    } as const satisfies __ctHelpers.JSONSchema, (event, state) => {
        void event;
        void state;
    });
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
