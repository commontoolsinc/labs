/// <cts-enable />
import { derive, pattern, patternTool, type PatternToolResult, Writable } from "commontools";

const multiplier = Writable.of(2);
const prefix = Writable.of("Result: ");

type Output = {
  tool: PatternToolResult<Record<string, never>>;
};

export default pattern<Record<string, never>, Output>(() => {
  const tool = patternTool(({ value }: { value: number }) => {
    return derive({ value }, ({ value }) => {
      return prefix.get() + String(value * multiplier.get());
    });
  });

  return { tool };
});
