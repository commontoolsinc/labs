/// <cts-enable />
import { pattern, UI } from "commontools";

interface State {
  entries: Array<{ 0: number }>;
}

export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {state.entries.map(({ 0: first }) => (
          <span>{first}</span>
        ))}
      </div>
    ),
  };
});
