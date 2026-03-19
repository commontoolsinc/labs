import * as __ctHelpers from "commontools";
import { cell } from "commontools";
// FIXTURE: literal-widen-boolean
// Verifies: boolean literals (true/false) are widened to { type: "boolean" } schema
//   cell(true) → cell(true, { type: "boolean" })
//   cell(false) → cell(false, { type: "boolean" })
export default function TestLiteralWidenBoolean() {
    const _b1 = cell(true, {
        type: "boolean"
    } as const satisfies __ctHelpers.JSONSchema);
    const _b2 = cell(false, {
        type: "boolean"
    } as const satisfies __ctHelpers.JSONSchema);
    return null;
}
void __ctHelpers;
