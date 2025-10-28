/// <cts-enable />
import { recipe, UI } from "commontools";

interface State {
  entries: Array<{ zero: number }>;
}

export default recipe<State>("MapDestructuredNumericAlias", (state) => {
  return {
    [UI]: (
      <div>
        {state.entries.map(({ zero: first }) => (
          <span>{first}</span>
        ))}
      </div>
    ),
  };
});
