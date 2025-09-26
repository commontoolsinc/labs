/// <cts-enable />
import { derive as deriveAlias, JSONSchema } from "commontools";
type AliasInput = {
    text: string;
};
type AliasResult = {
    length: number;
};
declare const state: AliasInput;
export const textLength = deriveAlias({
    type: "object",
    properties: {
        text: {
            type: "string"
        }
    },
    required: ["text"]
} as const satisfies JSONSchema, {
    type: "object",
    properties: {
        length: {
            type: "number"
        }
    },
    required: ["length"]
} as const satisfies JSONSchema, state, (value) => ({
    length: value.text.length,
}));
