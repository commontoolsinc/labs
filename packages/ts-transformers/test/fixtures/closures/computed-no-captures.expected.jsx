import * as __ctHelpers from "commontools";
import { computed, pattern } from "commontools";
// FIXTURE: computed-no-captures
// Verifies: computed(() => expr) with no external captures is transformed to derive() with empty captures
//   computed(() => 42) → derive({ type: "object", properties: {} }, resultSchema, {}, () => 42)
// Context: The capture schema has no properties and the captures object is empty {}.
//   The callback parameter list is also empty (no destructuring needed).
export default pattern(() => {
    const result = __ctHelpers.derive({
        type: "object",
        properties: {}
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, {}, () => 42);
    return result;
}, false as const satisfies __ctHelpers.JSONSchema, {
    type: "number"
} as const satisfies __ctHelpers.JSONSchema);
void __ctHelpers;
