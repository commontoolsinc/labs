import { computed, pattern } from "commonfabric";

export default pattern(() => {
  const assert_trivial = computed(() => true);

  return {
    tests: [{ assertion: assert_trivial }],
  };
});
