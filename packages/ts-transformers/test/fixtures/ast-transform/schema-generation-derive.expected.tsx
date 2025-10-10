import * as __ctHelpers from "commontools";
import { derive } from "commontools";
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
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        doubled: {
            type: "number"
        }
    },
    required: ["doubled"]
} as const satisfies __ctHelpers.JSONSchema, source, (input) => ({
    doubled: input.count * 2,
}));
__ctHelpers.NAME; // <internals>
