/// <cts-enable />
import { recipe, UI } from "commontools";

interface State {
  items: number[];
  highlight: string;
}

export default recipe<State>("MapOuterElement", (state) => {
  const element = state.highlight;
  return {
    [UI]: (
      <div>
        {state.items.map(() => (
          <span>{element}</span>
        ))}
      </div>
    ),
  };
});
