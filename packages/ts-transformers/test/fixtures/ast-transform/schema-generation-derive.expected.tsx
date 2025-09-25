/// <cts-enable />
import { derive, JSONSchema } from "commontools";
type DeriveInput = {
    count: number;
};
type DeriveResult = {
    doubled: number;
};
declare const source: DeriveInput;
export const doubledValue = derive({
    type: "object",
    properties: {
        count: {
            type: "number"
        }
    },
    required: ["count"]
} as const satisfies JSONSchema, {
    type: "object",
    properties: {
        doubled: {
            type: "number"
        }
    },
    required: ["doubled"]
} as const satisfies JSONSchema, source, (input) => ({
    doubled: input.count * 2,
}));
