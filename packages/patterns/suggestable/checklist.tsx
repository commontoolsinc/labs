/// <cts-enable />
import {
  computed,
  Default,
  generateObject,
  ifElse,
  NAME,
  pattern,
  UI,
  type VNode,
} from "commontools";

// ===== Types =====

type ChecklistInput = {
  topic?: Default<string, "">;
  context?: Default<Record<string, any>, Record<string, never>>;
};

type ChecklistItem = {
  label: string;
  done: Default<boolean, false>;
};

type ChecklistOutput = {
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

    const response = generateObject<{ items: ChecklistItem[] }>({
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

    // Seed items from LLM result when it arrives
    const items = computed(() => {
      return response.result?.items || [];
    });

    return {
      [NAME]: computed(() => (topic ? `Checklist: ${topic}` : "Checklist")),
      [UI]: (
        <ct-screen>
          <ct-vstack slot="header" gap="1">
            <ct-heading level={4}>
              {computed(() => topic || "Checklist")}
            </ct-heading>
          </ct-vstack>

          <ct-vstack gap="2" style="padding: 1.5rem;">
            {ifElse(
              response.pending,
              <div style="color: var(--ct-color-text-secondary);">
                <ct-loader show-elapsed /> Generating checklist...
              </div>,
              <div>
                {items.map((item) => (
                  <ct-hstack gap="2" align="center">
                    <ct-checkbox $checked={item.done}>{item.label}</ct-checkbox>
                  </ct-hstack>
                ))}
              </div>,
            )}
          </ct-vstack>
        </ct-screen>
      ),
      topic,
      items,
      pending: response.pending,
    };
  },
);

export default Checklist;
