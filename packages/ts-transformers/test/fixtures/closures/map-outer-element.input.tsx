/// <cts-enable />
import { pattern, UI } from "commontools";

interface State {
  items: number[];
  highlight: string;
}

export default pattern<State>("MapOuterElement", (state) => {
  const element = state.highlight;
  return {
    [UI]: (
      <div>
        {state.items.map((_, index) => (
          <span key={index}>{element}</span>
        ))}
      </div>
    ),
  };
});
