import * as __ctHelpers from "commontools";
import { computed } from "commontools";
// FIXTURE: computed-alias-const-rewrite
// Verifies: stable const aliases to `computed()` still lower to `derive()`.
const alias = computed;
export default __ctHelpers.derive({
    type: "object",
    properties: {}
} as const satisfies __ctHelpers.JSONSchema, {
    type: "number"
} as const satisfies __ctHelpers.JSONSchema, {}, () => 1);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
