/// <cts-enable />
import { pattern, UI } from "commontools";

interface State {
  multiplier: number;
}

export default pattern<State>("PlainArrayNoTransform", (state) => {
  const plainArray = [1, 2, 3, 4, 5];

  return {
    [UI]: (
      <div>
        {/* Plain array should NOT be transformed, even with captures */}
        {plainArray.map((n) => (
          <span>{n * state.multiplier}</span>
        ))}
      </div>
    ),
  };
});
