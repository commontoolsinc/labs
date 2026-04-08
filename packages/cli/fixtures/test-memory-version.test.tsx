/// <cts-enable />
import { computed, pattern } from "commonfabric";

export default pattern(() => ({
  tests: [
    { assertion: computed(() => true) },
  ],
}));
