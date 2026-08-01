import { computed, pattern } from "commonfabric";

export default pattern(() => ({
  tests: [
    { render: [null, undefined, "text", 1, true, false, []] },
    { assertion: computed(() => true) },
  ],
}));
