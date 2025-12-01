import * as __ctHelpers from "commontools";
import { lift } from "commontools";
// Testing schema generation when no type annotations are provided
// @ts-expect-error Testing untyped lift: value is unknown but transformer handles gracefully
export const doubleValue = lift(true as const satisfies __ctHelpers.JSONSchema, {
    type: "number"
} as const satisfies __ctHelpers.JSONSchema, (value) => value * 2);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
