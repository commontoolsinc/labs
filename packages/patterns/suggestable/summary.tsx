/// <cts-enable />
import {
  computed,
  Default,
  generateText,
  ifElse,
  NAME,
  pattern,
  UI,
  type VNode,
} from "commontools";

// ===== Types =====

type SummaryInput = {
  topic?: Default<string, "">;
  context?: Default<Record<string, any>, {}>;
};

type SummaryOutput = {
  [NAME]: string;
  [UI]: VNode;
  topic: string;
  summary: string;
  pending: boolean;
};

// ===== Pattern =====

/**
 * Generates a concise summary of provided context using an LLM.
 * Designed as "suggestion fuel" - a lightweight utility pattern that can be
 * instantiated across many different contexts.
 */
const Summary = pattern<SummaryInput, SummaryOutput>(({ topic, context }) => {
  // Build the prompt dynamically based on topic and context
  const prompt = computed(() => {
    const t = topic || "the following";
    return `Please provide a concise, well-structured summary of ${t}`;
  });

  // Generate the summary
  const response = generateText({
    system:
      "You are a helpful assistant that creates clear, concise summaries. Focus on the key points and structure your response in a readable way.",
    prompt,
    context,
  });

  return {
    [NAME]: computed(() => (topic ? `Summary: ${topic}` : "Summary")),
    [UI]: (
      <ct-screen>
        <ct-vstack slot="header" gap="1">
          <ct-heading level={4}>
            {computed(() => topic || "Summary")}
          </ct-heading>
        </ct-vstack>

        <ct-vstack gap="3" style="padding: 1.5rem;">
          {ifElse(
            response.pending,
            <div style="color: var(--ct-color-text-secondary);">
              <ct-loader show-elapsed /> Generating summary...
            </div>,
            <div style="line-height: 1.6; white-space: pre-wrap;">
              {response.result}
            </div>,
          )}
        </ct-vstack>
      </ct-screen>
    ),
    topic,
    summary: computed(() => response.result || ""),
    pending: response.pending,
  };
});

export default Summary;
