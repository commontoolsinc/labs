/// <cts-enable />
import { Default, NAME, pattern, UI } from "commontools";

interface PatternState {
  count: Default<number, 0>;
  label: Default<string, "">;
}

export default pattern<PatternState>((state) => {
  return {
    [NAME]: state.label,
    [UI]: (
      <section>
        {state.count > 0 ? <p>Positive</p> : <p>Non-positive</p>}
      </section>
    ),
  };
});
