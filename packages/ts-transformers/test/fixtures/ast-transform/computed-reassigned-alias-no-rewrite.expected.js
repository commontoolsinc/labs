import * as __cfHelpers from "commonfabric";
import { computed } from "commonfabric";
// FIXTURE: computed-reassigned-alias-no-rewrite
// Verifies: mutable aliases to `computed()` are not treated as stable builder aliases.
let alias = computed;
alias = ((fn: () => number) => fn()) as typeof alias;
export default alias(() => 1);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
