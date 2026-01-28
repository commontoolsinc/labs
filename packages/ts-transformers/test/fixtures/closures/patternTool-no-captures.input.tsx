/// <cts-enable />
import { derive, patternTool } from "commontools";

// No external captures - should not be transformed by PatternToolStrategy
const tool = patternTool(({ query, content }: { query: string; content: string }) => {
  return derive({ query, content }, ({ query, content }) => {
    return content.split("\n").filter((c: string) => c.includes(query));
  });
});

export default tool;
