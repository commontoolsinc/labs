import * as __ctHelpers from "commontools";
import { derive as deriveAlias } from "commontools";
type AliasInput = {
    text: string;
};
type AliasResult = {
    length: number;
};
declare const state: AliasInput;
// FIXTURE: schema-generation-derive-alias
// Verifies: derive imported under an alias still gets schema injection
//   deriveAlias<AliasInput, AliasResult>(state, fn) → deriveAlias(inputSchema, outputSchema, state, fn)
// Context: Uses `import { derive as deriveAlias }` to test aliased import tracking
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
void __ctHelpers;
