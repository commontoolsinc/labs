import * as __ctHelpers from "commontools";
import { lift } from "commontools";
// FIXTURE: schema-generation-lift-typed-param
// Verifies: lift() with a primitive typed parameter generates scalar input and output schemas
//   lift((value: number) => value * 2) → lift({ type: "number" }, { type: "number" }, fn)
// Context: Single primitive param; output type inferred from expression body
// Lift requires explicit type annotation for proper schema generation
export const doubleValue = lift({
    type: "number"
} as const satisfies __ctHelpers.JSONSchema, {
    type: "number"
} as const satisfies __ctHelpers.JSONSchema, (value: number) => value * 2);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
