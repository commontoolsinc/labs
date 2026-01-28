/// <cts-enable />
import { cell, derive, patternTool } from "commontools";

const content = cell("Hello world\nGoodbye world");

const grepTool = patternTool(({ query }: { query: string }) => {
  return derive({ query }, ({ query }) => {
    return content.get().split("\n").filter((c: string) => c.includes(query));
  });
});

export default grepTool;
