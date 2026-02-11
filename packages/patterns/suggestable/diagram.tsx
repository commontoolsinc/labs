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

type DiagramInput = {
  topic?: Default<string, "">;
  context?: Default<Record<string, any>, Record<string, never>>;
};

type DiagramOutput = {
  [NAME]: string;
  [UI]: VNode;
  topic: string;
  diagram: string;
  pending: boolean;
};

// ===== Pattern =====

/**
 * Generates an ASCII diagram illustrating relationships, flows, or structures.
 * Designed as "suggestion fuel" - a lightweight utility pattern for visual
 * representation of concepts using plain text art.
 */
const Diagram = pattern<DiagramInput, DiagramOutput>(({ topic, context }) => {
  const prompt = computed(() => {
    const t = topic || "the following";
    return `Create a clear ASCII diagram illustrating: ${t}`;
  });

  const response = generateText({
    system:
      "You create clear, well-structured ASCII diagrams using box-drawing characters, arrows, and text art. Use ┌─┐│└─┘ for boxes, ──▶ for arrows, and keep diagrams compact but readable. Output ONLY the diagram with no surrounding explanation.",
    prompt,
    context,
  });

  return {
    [NAME]: computed(() => (topic ? `Diagram: ${topic}` : "Diagram")),
    [UI]: (
      <ct-screen>
        <ct-vstack slot="header" gap="1">
          <ct-heading level={4}>
            {computed(() => topic || "Diagram")}
          </ct-heading>
        </ct-vstack>

        <ct-vstack gap="3" style="padding: 1.5rem;">
          {ifElse(
            response.pending,
            <div style="color: var(--ct-color-text-secondary);">
              <ct-loader show-elapsed /> Generating diagram...
            </div>,
            <pre style="font-family: monospace; font-size: 0.85rem; line-height: 1.4; overflow-x: auto; white-space: pre; background: var(--ct-color-surface-secondary, #f5f5f5); padding: 1rem; border-radius: 0.5rem;">
              {response.result}
            </pre>,
          )}
        </ct-vstack>
      </ct-screen>
    ),
    topic,
    diagram: computed(() => response.result || ""),
    pending: response.pending,
  };
});

export default Diagram;
