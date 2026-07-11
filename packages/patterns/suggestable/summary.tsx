import {
  computed,
  Default,
  generateText,
  ifElse,
  isPending,
  NAME,
  pattern,
  resultOf,
  UI,
  type VNode,
} from "commonfabric";

// ===== Types =====

type SummaryInput = {
  topic?: string | Default<"">;
  context?: Record<string, any> | Default<Record<string, never>>;
};

export type SummaryOutput = {
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
  const responseRequest = generateText({
    system:
      "You are a helpful assistant that creates clear, concise summaries. Focus on the key points and structure your response in a readable way.",
    prompt,
    context,
  });
  const response = resultOf(responseRequest);

  return {
    [NAME]: computed(() => (topic ? `Summary: ${topic}` : "Summary")),
    [UI]: (
      <cf-screen>
        <cf-vstack slot="header" gap="1">
          <cf-heading level={4}>
            {computed(() => topic || "Summary")}
          </cf-heading>
        </cf-vstack>

        <cf-vstack gap="3" style="padding: 1.5rem;">
          {ifElse(
            isPending(responseRequest),
            <div style="color: var(--cf-theme-color-text-secondary);">
              <cf-loader show-elapsed /> Generating summary...
            </div>,
            <div style="line-height: 1.6; white-space: pre-wrap;">
              {response}
            </div>,
          )}
        </cf-vstack>
      </cf-screen>
    ),
    topic,
    summary: computed(() => response || ""),
    pending: isPending(responseRequest),
  };
});

export default Summary;
