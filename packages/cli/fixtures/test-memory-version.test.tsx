/// <cts-enable />
import { computed, pattern } from "commontools";

export default pattern(() => ({
  tests: [
    { assertion: computed(() => true) },
  ],
}));
