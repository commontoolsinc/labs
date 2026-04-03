/// <cts-enable />
import { derive, pattern, patternTool, type PatternToolResult } from "commonfabric";

type Output = {
  tool: PatternToolResult<Record<string, never>>;
};

// No external captures - should not be transformed by PatternToolStrategy
// FIXTURE: patternTool-no-captures
// Verifies: patternTool with no external captures leaves extraParams empty
//   patternTool(fn) → patternTool(fn) with no extraParams modifications
// Context: Negative test — when the patternTool callback only references its own
//   parameters (query, content) and no module-scoped reactive variables, the
//   transformer should not inject any extraParams.
export default pattern<Record<string, never>, Output>(() => {
  const tool = patternTool(({ query, content }: { query: string; content: string }) => {
    return derive({ query, content }, ({ query, content }) => {
      return content.split("\n").filter((c: string) => c.includes(query));
    });
  });

  return { tool };
});
