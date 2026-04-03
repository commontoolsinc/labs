import * as __cfHelpers from "commonfabric";
import { computed } from "commonfabric";
// FIXTURE: computed-alias-const-rewrite
// Verifies: stable const aliases to `computed()` still lower to `derive()`.
const alias = computed;
export default __cfHelpers.derive({
    type: "object",
    properties: {}
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, {}, () => 1);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
