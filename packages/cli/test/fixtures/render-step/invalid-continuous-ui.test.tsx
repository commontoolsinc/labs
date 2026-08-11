import { computed, pattern, UI, type VNode } from "commonfabric";

export default pattern(() => ({
  // Deliberately not a real VNode at run time: this fixture feeds the runner
  // an invalid continuous-UI value to check how it reports one.
  [UI]: {} as VNode,
  tests: [{ assertion: computed(() => true) }],
}));
