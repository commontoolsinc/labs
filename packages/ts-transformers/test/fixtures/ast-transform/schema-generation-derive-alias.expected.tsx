import * as __ctHelpers from "commontools";
import { derive as deriveAlias } from "commontools";
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
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        length: {
            type: "number"
        }
    },
    required: ["length"]
} as const satisfies __ctHelpers.JSONSchema, state, (value) => ({
    length: value.text.length,
}));
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
