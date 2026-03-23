/// <cts-enable />
import { computed, pattern, UI } from "commontools";

const wrap = (x: unknown) => x;

interface Item {
  done: boolean;
}

interface State {
  items: Item[];
}

// FIXTURE: computed-map-call-arg-logical-and
// Verifies: nested && inside a callback-local call argument within a
//   computed-array .map() callback is lowered to when().
//   const label = wrap(row.done && "Done")
//   → const label = wrap(when(row.done, "Done"))
export default pattern<State>((state) => {
  const rows = computed(() => state.items);

  return {
    [UI]: (
      <div>
        {rows.map((row) => {
          const label = wrap(row.done && "Done");
          return <span>{label}</span>;
        })}
      </div>
    ),
  };
});
