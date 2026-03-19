import * as __ctHelpers from "commontools";
import { derive } from "commontools";
declare const total: number;
// FIXTURE: schema-generation-derive-untyped
// Verifies: derive() with no generic type args infers schemas from the declared source type
//   derive(total, fn) → derive({ type: "number" }, { type: "number" }, total, fn)
// Context: Input type comes from `declare const total: number`; output inferred from arrow body
export const doubled = derive({
    type: "number"
} as const satisfies __ctHelpers.JSONSchema, {
    type: "number"
} as const satisfies __ctHelpers.JSONSchema, total, (value) => value * 2);
void __ctHelpers;
