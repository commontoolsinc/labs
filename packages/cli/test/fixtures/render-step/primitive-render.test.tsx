import { computed, pattern } from "commonfabric";

export default pattern(() => ({
  tests: [
    { render: null },
    { render: "text" },
    { render: 1 },
    { render: true },
    { assertion: computed(() => true) },
  ],
}));
