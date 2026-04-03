import * as __cfHelpers from "commonfabric";
import { derive as deriveAlias } from "commonfabric";
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
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        length: {
            type: "number"
        }
    },
    required: ["length"]
} as const satisfies __cfHelpers.JSONSchema, state, (value) => ({
    length: value.text.length,
}));
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
