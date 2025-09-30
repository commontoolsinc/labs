/// <cts-enable />
import { lift, JSONSchema } from "commontools";
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
} as const satisfies JSONSchema, {
    type: "object",
    properties: {
        doubled: {
            type: "number"
        }
    },
    required: ["doubled"]
} as const satisfies JSONSchema, (args: LiftArgs): LiftResult => ({
    doubled: args.value * 2,
}));
