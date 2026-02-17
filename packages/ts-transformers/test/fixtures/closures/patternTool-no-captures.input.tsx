/// <cts-enable />
import { derive, pattern, patternTool, type PatternToolResult } from "commontools";

type Output = {
  tool: PatternToolResult<Record<string, never>>;
};

// No external captures - should not be transformed by PatternToolStrategy
export default pattern<Record<string, never>, Output>(() => {
  const tool = patternTool(({ query, content }: { query: string; content: string }) => {
    return derive({ query, content }, ({ query, content }) => {
      return content.split("\n").filter((c: string) => c.includes(query));
    });
  });

  return { tool };
});
