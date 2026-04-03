import * as __cfHelpers from "commonfabric";
import { lift } from "commonfabric";
type LiftArgs = {
    value: number;
};
type LiftResult = {
    doubled: number;
};
// FIXTURE: schema-generation-lift
// Verifies: lift() with generic type args generates input and output schemas
//   lift<LiftArgs, LiftResult>(fn) → lift(inputSchema, outputSchema, fn)
export const doubleValue = lift({
    type: "object",
    properties: {
        value: {
            type: "number"
        }
    },
    required: ["value"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        doubled: {
            type: "number"
        }
    },
    required: ["doubled"]
} as const satisfies __cfHelpers.JSONSchema, ({ value }) => ({
    doubled: value * 2,
}));
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
