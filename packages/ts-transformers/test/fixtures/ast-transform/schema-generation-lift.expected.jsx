import * as __ctHelpers from "commontools";
import { lift } from "commontools";
type LiftArgs = {
    value: number;
};
type LiftResult = {
    doubled: number;
};
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
} as const satisfies __ctHelpers.JSONSchema, ({ value }) => ({
    doubled: value * 2,
}));
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
