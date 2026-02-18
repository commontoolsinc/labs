/// <cts-enable />
import { pattern, UI } from "commontools";

interface State {
  items: Array<{ value: number }>;
  multiplier: number;
}

export default pattern<State>((state) => {
  return {
    [UI]: (
      <button
        type="button"
        onClick={() => {
          const scaled = state.items.map((item) => item.value * state.multiplier);
          console.log(scaled);
        }}
      >
        Compute
      </button>
    ),
  };
});
