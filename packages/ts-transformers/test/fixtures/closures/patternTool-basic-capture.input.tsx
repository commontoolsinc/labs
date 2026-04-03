/// <cts-enable />
import { cell, derive, pattern, patternTool, type PatternToolResult } from "commonfabric";

const content = cell("Hello world\nGoodbye world");

type Output = {
  grepTool: PatternToolResult<{ content: string }>;
};

// FIXTURE: patternTool-basic-capture
// Verifies: patternTool captures a module-scoped cell as an extraParam
//   patternTool(fn, { content }) → patternTool(fn, { content }) (content passed through)
//   derive({ query }, ...) inside tool → derive({ input: { query }, content }, ...) with content captured
// Context: Module-scoped `content` cell is referenced inside the patternTool
//   callback. The transformer threads it through the existing extraParams object.
export default pattern<Record<string, never>, Output>(() => {
  const grepTool = patternTool(({ query, content }: { query: string; content: string }) => {
    return derive({ query }, ({ query }) => {
      return content.split("\n").filter((c: string) => c.includes(query));
    });
  }, { content });

  return { grepTool };
});
