/// <cts-enable />
import { cell, derive, pattern, patternTool, type PatternToolResult } from "commontools";

const content = cell("Hello world\nGoodbye world");

type Output = {
  grepTool: PatternToolResult<{ content: string }>;
};

export default pattern<Record<string, never>, Output>(() => {
  const grepTool = patternTool(({ query, content }: { query: string; content: string }) => {
    return derive({ query }, ({ query }) => {
      return content.split("\n").filter((c: string) => c.includes(query));
    });
  }, { content });

  return { grepTool };
});
