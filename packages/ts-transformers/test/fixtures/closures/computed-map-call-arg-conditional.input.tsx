import { computed, pattern, UI } from "commonfabric";

const identity = (x: string) => x;

interface Item {
  done: boolean;
}

interface State {
  items: Item[];
}

// FIXTURE: computed-map-call-arg-conditional
// Verifies: nested ternary inside a callback-local call argument within a
//   computed-array .map() callback is lowered to ifElse().
//   const label = identity(row.done ? "Done" : "Pending")
//   → const label = identity(ifElse(row.done, "Done", "Pending"))
export default pattern<State>((state) => {
  const rows = computed(() => state.items);

  return {
    [UI]: (
      <div>
        {rows.map((row) => {
          const label = identity(row.done ? "Done" : "Pending");
          return <span>{label}</span>;
        })}
      </div>
    ),
  };
});
