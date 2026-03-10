/// <cts-enable />
import { derive, pattern, patternTool, type PatternToolResult, Writable } from "commontools";

const multiplier = Writable.of(2);
const prefix = Writable.of("Result: ");

type Output = {
  tool: PatternToolResult<Record<string, never>>;
};

// FIXTURE: patternTool-multiple-captures
// Verifies: patternTool with no explicit extraParams auto-captures multiple module-scoped reactive vars
//   patternTool(fn) → patternTool(fn, { prefix, multiplier })
//   callback signature gains captured params: ({ value }) → ({ value, prefix, multiplier })
// Context: Both `prefix` and `multiplier` are module-scoped Writable.of() values
//   referenced via .get() inside the callback. The transformer detects both and
//   injects them into the extraParams object and the callback's destructured input.
export default pattern<Record<string, never>, Output>(() => {
  const tool = patternTool(({ value }: { value: number }) => {
    return derive({ value }, ({ value }) => {
      return prefix.get() + String(value * multiplier.get());
    });
  });

  return { tool };
});
