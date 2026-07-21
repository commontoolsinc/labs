import {
  computed,
  Default,
  generateObject,
  ifElse,
  isPending,
  NAME,
  pattern,
  resultOf,
  UI,
  type VNode,
} from "commonfabric";

// ===== Types =====

type ChecklistInput = {
  topic?: string | Default<"">;
  context?: Record<string, any> | Default<Record<string, never>>;
};

type ChecklistItem = {
  label: string;
  done: boolean | Default<false>;
};

export type ChecklistOutput = {
  [NAME]: string;
  [UI]: VNode;
  topic: string;
  items: ChecklistItem[];
  pending: boolean;
};

// ===== Pattern =====

/**
 * Generates a checklist of actionable steps from a topic and context using an LLM.
 * Designed as "suggestion fuel" - turns vague intent into concrete steps.
 */
const Checklist = pattern<ChecklistInput, ChecklistOutput>(
  ({ topic, context }) => {
    const prompt = computed(() => {
      const t = topic || "the following";
      return `Generate a checklist of actionable steps for: ${t}`;
    });

    const responseRequest = generateObject<{ items: ChecklistItem[] }>({
      system:
        "You generate concise, actionable checklists. Each item should be a clear, specific step. Keep it to 5-10 items unless the task clearly requires more.",
      prompt,
      context,
      schema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                done: { type: "boolean", default: false },
              },
              required: ["label"],
            },
          },
        },
        required: ["items"],
      },
      model: "anthropic:claude-haiku-4-5",
    });
    const response = resultOf(responseRequest);

    // Seed items from LLM result when it arrives
    const items = computed(() => {
      return response.items || [];
    });

    return {
      [NAME]: computed(() => (topic ? `Checklist: ${topic}` : "Checklist")),
      [UI]: (
        <cf-screen>
          <cf-vstack slot="header" gap="1">
            <cf-heading level={4}>
              {computed(() => topic || "Checklist")}
            </cf-heading>
          </cf-vstack>

          <cf-vstack gap="2" style="padding: 1.5rem;">
            {ifElse(
              isPending(responseRequest),
              <div style="color: var(--cf-theme-color-text-secondary);">
                <cf-loader show-elapsed /> Generating checklist...
              </div>,
              <div>
                {items.map((item) => (
                  <cf-hstack gap="2" align="center">
                    <cf-checkbox $checked={item.done}>{item.label}</cf-checkbox>
                  </cf-hstack>
                ))}
              </div>,
            )}
          </cf-vstack>
        </cf-screen>
      ),
      topic,
      items,
      pending: isPending(responseRequest),
    };
  },
);

export default Checklist;
