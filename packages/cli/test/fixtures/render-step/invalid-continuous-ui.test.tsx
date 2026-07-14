import { computed, pattern, UI } from "commonfabric";

export default pattern(() => ({
  [UI]: {},
  tests: [{ assertion: computed(() => true) }],
}));
