/// <cts-enable />
import { pattern, UI } from "commontools";

interface State {
  sortedTags: string[];
  tagCounts: Record<string, number>;
}

export default pattern<State>("MapElementAccessOpaque", (state) => {
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
