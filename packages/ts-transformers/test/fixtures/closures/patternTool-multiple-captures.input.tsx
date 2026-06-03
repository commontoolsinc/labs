import {
  computed,
  pattern,
  patternTool,
  type PatternToolResult,
  Writable,
} from "commonfabric";

const multiplier = new Writable(2);
const prefix = new Writable("Result: ");

type Output = {
  tool: PatternToolResult<Record<string, never>>;
};

// FIXTURE: patternTool-multiple-captures
// Verifies: patternTool with no explicit extraParams auto-captures multiple module-scoped reactive vars
//   patternTool(fn) → patternTool(fn, { prefix, multiplier })
//   callback signature gains captured params: ({ value }) → ({ value, prefix, multiplier })
// Context: Both `prefix` and `multiplier` are module-scoped new Writable() values
//   referenced via .get() inside the callback. The transformer detects both and
//   injects them into the extraParams object and the callback's destructured input.
export default pattern<Record<string, never>, Output>(() => {
  const tool = patternTool(({ value }: { value: number }) => {
    return computed(() => {
      return prefix.get() + String(value * multiplier.get());
    });
  });

  return { tool };
});
