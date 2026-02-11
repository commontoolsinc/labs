/// <cts-enable />
import {
  computed,
  Default,
  generateObject,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commontools";

// ===== Types =====

type QuestionInput = {
  topic?: Default<string, "">;
  context?: Default<Record<string, any>, {}>;
};

type QuestionOutput = {
  [NAME]: string;
  [UI]: VNode;
  topic: string;
  question: string;
  options: string[];
  answer: Writable<string>;
  pending: boolean;
};

// ===== Handler (module scope) =====

const onAnswer = handler<
  { detail: { answer: string } },
  { answer: Writable<string> }
>(({ detail }, { answer }) => {
  answer.set(detail.answer);
});

// ===== Pattern =====

/**
 * Generates a clarifying question to ask the user based on the topic and context.
 * Designed as "suggestion fuel" - useful when the system needs more information
 * before proceeding, or to prompt the user to think about something.
 */
const Question = pattern<QuestionInput, QuestionOutput>(
  ({ topic, context }) => {
    const prompt = computed(() => {
      const t = topic || "the current situation";
      return `Generate a single, thoughtful clarifying question about: ${t}. Include 2-4 multiple choice options if appropriate, or leave options empty for a free-text answer.`;
    });

    const response = generateObject<{
      question: string;
      options: string[];
    }>({
      system:
        "You generate thoughtful, specific questions that help clarify intent or gather useful information. Questions should be concise and actionable. Provide 2-4 multiple choice options when the answer space is bounded, or an empty options array for open-ended questions.",
      prompt,
      context,
      schema: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["question", "options"],
      },
      model: "anthropic:claude-haiku-4-5",
    });

    const answer = Writable.of("");

    return {
      [NAME]: computed(() => (topic ? `Question: ${topic}` : "Question")),
      [UI]: (
        <ct-screen>
          <ct-vstack slot="header" gap="1">
            <ct-heading level={4}>
              {computed(() => topic || "Question")}
            </ct-heading>
          </ct-vstack>

          <ct-vstack gap="3" style="padding: 1.5rem;">
            {ifElse(
              response.pending,
              <div style="color: var(--ct-color-text-secondary);">
                <ct-loader show-elapsed /> Generating question...
              </div>,
              <ct-question
                question={computed(
                  () => response.result?.question || "",
                )}
                options={computed(
                  () => response.result?.options || [],
                )}
                onct-answer={onAnswer({ answer })}
              />,
            )}
          </ct-vstack>
        </ct-screen>
      ),
      topic,
      question: computed(() => response.result?.question || ""),
      options: computed(() => response.result?.options || []),
      answer,
      pending: response.pending,
    };
  },
);

export default Question;
