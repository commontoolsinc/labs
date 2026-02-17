/// <cts-enable />
import { computed, generateText, patternTool, Writable } from "commontools";

const content = Writable.of("Hello world");

// Regression test: local variables (genResult) must NOT be captured as
// extraParams, even when they have a reactive type. Only module-scoped
// reactive variables (content) should be captured.
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

export default tool;
