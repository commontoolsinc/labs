import { computed, pattern } from "commonfabric";

const identity = (value: string) => value;

interface Item {
  done: boolean;
}

interface State {
  items: Item[];
}

// FIXTURE: computed-map-call-root-containers
// Verifies: inside a computed-array .map() callback, nested structural sites
//   still lower inner conditionals directly, while a direct callback
//   return-expression ordinary call root lowers as a whole callback-local
//   derive.
//   ({ value: identity(row.done ? "Done" : "Pending") })
//   → ({ value: identity(ifElse(row.done, "Done", "Pending")) })
//   [identity(row.done ? "Done" : "Pending")]
//   → [identity(ifElse(row.done, "Done", "Pending"))]
//   row => identity(row.done ? "Done" : "Pending")
//   → row => derive(..., ({ row }) => identity(row.done ? "Done" : "Pending"))
export default pattern<
  State,
  { views: { value: string; list: string[] }[]; labels: string[] }
>((state) => {
  const rows = computed(() => state.items);

  const views = rows.map((row) => ({
    value: identity(row.done ? "Done" : "Pending"),
    list: [identity(row.done ? "Done" : "Pending")],
  }));

  const labels = rows.map((row) =>
    identity(row.done ? "Done" : "Pending")
  );

  return { views, labels };
});
