/// <cts-enable />
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
export const textLength = deriveAlias<AliasInput, AliasResult>(
  state,
  (value) => ({
    length: value.text.length,
  }),
);
