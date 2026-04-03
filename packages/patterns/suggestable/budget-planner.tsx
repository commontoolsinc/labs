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

type BudgetInput = {
  topic?: Default<string, "">;
  context?: Default<Record<string, any>, Record<string, never>>;
  maxAmount?: Default<number, 1000>;
};

type BudgetItem = {
  name: string;
  amount: Default<number, 0>;
};

type BudgetOutput = {
  [NAME]: string;
  [UI]: VNode;
  topic: string;
  items: BudgetItem[];
  total: number;
  remaining: number;
  pending: boolean;
};

// ===== Pattern =====

/**
 * Generates a budget breakdown with adjustable amounts for each category.
 * Designed as "suggestion fuel" - suggests spending categories that fit
 * within a given budget ceiling.
 */
const BudgetPlanner = pattern<BudgetInput, BudgetOutput>(
  ({ topic, context, maxAmount }) => {
    const prompt = computed(() => {
      const t = topic || "a general budget";
      return `Create a budget breakdown for: ${t}. Suggest 4-8 spending categories with dollar amounts that sum to exactly $${maxAmount}.`;
    });

    const response = generateObject<{ items: BudgetItem[] }>({
      system:
        "You create practical budget breakdowns. Each item should have a descriptive name and a reasonable dollar amount. Keep categories specific and actionable. Amounts should be whole numbers.",
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
                name: { type: "string" },
                amount: { type: "number" },
              },
              required: ["name", "amount"],
            },
          },
        },
        required: ["items"],
      },
      model: "anthropic:claude-haiku-4-5",
    });

    const items = computed(() => response.result?.items || []);

    const total = computed(() => {
      let sum = 0;
      for (const item of items) {
        sum += item.amount || 0;
      }
      return sum;
    });

    const remaining = computed(() => (maxAmount || 0) - total);

    return {
      [NAME]: computed(() => (topic ? `Budget: ${topic}` : "Budget Planner")),
      [UI]: (
        <ct-screen>
          <ct-vstack slot="header" gap="1">
            <ct-heading level={4}>
              {computed(() => topic || "Budget Planner")}
            </ct-heading>
            <span style="color: var(--ct-color-text-secondary); font-size: 0.85rem;">
              Budget: ${maxAmount}
            </span>
          </ct-vstack>

          <ct-vstack gap="3" style="padding: 1.5rem;">
            {ifElse(
              response.pending,
              <div style="color: var(--ct-color-text-secondary);">
                <ct-loader show-elapsed /> Generating budget...
              </div>,
              <ct-vstack gap="3">
                {items.map((item) => (
                  <ct-hstack gap="2" align="center">
                    <span style={{ flex: "1", fontWeight: "500" }}>
                      {item.name}
                    </span>
                    <ct-hstack gap="1" align="center">
                      <span style="color: var(--ct-color-text-secondary); font-size: 0.85rem;">
                        $
                      </span>
                      <ct-input
                        $value={item.amount}
                        style="width: 5rem; text-align: right;"
                      />
                    </ct-hstack>
                  </ct-hstack>
                ))}

                <div
                  style={{
                    borderTop: "2px solid var(--ct-color-border, #e5e7eb)",
                    paddingTop: "0.75rem",
                    marginTop: "0.25rem",
                  }}
                >
                  <ct-hstack gap="2" align="center">
                    <span style={{ flex: "1", fontWeight: "700" }}>Total</span>
                    <span style={{ fontWeight: "700" }}>${total}</span>
                  </ct-hstack>
                  <ct-hstack
                    gap="2"
                    align="center"
                    style="margin-top: 0.25rem;"
                  >
                    <span
                      style={{
                        flex: "1",
                        color: "var(--ct-color-text-secondary)",
                        fontSize: "0.85rem",
                      }}
                    >
                      Remaining
                    </span>
                    <span
                      style={{
                        fontSize: "0.85rem",
                        color: computed(() =>
                          remaining < 0
                            ? "var(--ct-color-danger, #ef4444)"
                            : "var(--ct-color-text-secondary)"
                        ),
                      }}
                    >
                      ${remaining}
                    </span>
                  </ct-hstack>
                </div>
              </ct-vstack>,
            )}
          </ct-vstack>
        </ct-screen>
      ),
      topic,
      items,
      total,
      remaining,
      pending: response.pending,
    };
  },
);

export default BudgetPlanner;
