/// <cts-enable />
import { cell, pattern, UI } from "commontools";

interface State {
  items: Array<{ value: number }>;
  threshold: number;
}

export default pattern<State>((state) => {
  const label = "Result";
  const limit = cell(100);
  const derived = state.threshold;
  return {
    [UI]: (
      <div>
        {state.items.map((item) => (
          <span>{label}: {item.value} / {derived} / {limit}</span>
        ))}
      </div>
    ),
  };
});
