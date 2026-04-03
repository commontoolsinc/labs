import * as __ctHelpers from "commontools";
import { lift } from "commontools";
type LiftArgs = {
    value: number;
};
type LiftResult = {
    doubled: number;
};
// FIXTURE: schema-generation-lift-no-generics
// Verifies: lift() with no generic type args infers schemas from inline param and return type
//   lift((args: LiftArgs): LiftResult => ...) → lift(inputSchema, outputSchema, fn)
// Context: Types come from function parameter and return type annotations, not generic args
export const doubleValue = lift({
    type: "object",
    properties: {
        value: {
            type: "number"
        }
    },
    required: ["value"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        doubled: {
            type: "number"
        }
    },
    required: ["doubled"]
} as const satisfies __ctHelpers.JSONSchema, (args: LiftArgs): LiftResult => ({
    doubled: args.value * 2,
}));
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
