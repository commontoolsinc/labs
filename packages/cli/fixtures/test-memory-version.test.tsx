import { computed, pattern, TESTS } from "commonfabric";

export default pattern(() => ({
  [TESTS]: [
    { assertion: computed(() => true) },
  ],
}));
