/// <cts-enable />
import { computed, generateText, pattern, patternTool, type PatternToolResult, Writable } from "commontools";

const content = Writable.of("Hello world");

type Output = {
  tool: PatternToolResult<{ content: string }>;
};

// Regression test: local variables (genResult) must NOT be captured as
// extraParams, even when they have a reactive type. Only module-scoped
// reactive variables (content) should be captured.
// FIXTURE: patternTool-local-var
// Verifies: patternTool captures module-scoped reactive var but NOT local variables
//   patternTool(fn, { content }) → extraParams includes only module-scoped `content`
//   genResult (local) is NOT added to extraParams despite having a reactive type
// Context: Regression test — local variables like `genResult` (from generateText)
//   must not be hoisted into extraParams. Only module-scoped reactive bindings
//   (here, `content` from Writable.of) should be captured.
export default pattern<Record<string, never>, Output>(() => {
  const tool = patternTool(
    ({ language, content }: { language: string; content: string }) => {
      const genResult = generateText({
        system: computed(() => `Translate to ${language}.`),
        prompt: computed(() => content),
      });
      return computed(() => {
        if (genResult.pending) return undefined;
        return genResult.result;
      });
    },
    { content },
  );

  return { tool };
});
