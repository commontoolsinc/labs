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
} as const satisfies __ctHelpers.JSONSchema, (args: LiftArgs): LiftResult => ({
    doubled: args.value * 2,
}));
__ctHelpers.NAME; // <internals>
