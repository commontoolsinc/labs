/// <cts-enable />
import { recipe, UI } from "commontools";

interface State {
  sortedTags: string[];
  tagCounts: Record<string, number>;
}

export default recipe<State>("MapElementAccessOpaque", (state) => {
  return {
    [UI]: (
      <div>
        {state.sortedTags.map((tag) => (
          <span>
            {tag}: {state.tagCounts[tag]}
          </span>
        ))}
      </div>
    ),
  };
});
