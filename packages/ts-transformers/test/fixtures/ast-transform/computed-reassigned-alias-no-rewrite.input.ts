/// <cts-enable />
import { computed } from "commontools";

// FIXTURE: computed-reassigned-alias-no-rewrite
// Verifies: mutable aliases to `computed()` are not treated as stable builder aliases.
let alias = computed;
alias = ((fn: () => number) => fn()) as typeof alias;

export default alias(() => 1);
