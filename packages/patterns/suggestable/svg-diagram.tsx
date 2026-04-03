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

type SvgDiagramInput = {
  topic?: Default<string, "">;
  context?: Default<Record<string, any>, Record<string, never>>;
};

type SvgDiagramOutput = {
  [NAME]: string;
  [UI]: VNode;
  topic: string;
  diagram: string;
  pending: boolean;
};

// ===== Pattern =====

/**
 * Generates an SVG diagram illustrating relationships, flows, or structures.
 * Designed as "suggestion fuel" - a lightweight utility pattern for visual
 * representation of concepts using scalable vector graphics.
 */
const SvgDiagram = pattern<SvgDiagramInput, SvgDiagramOutput>(
  ({ topic, context }) => {
    const prompt = computed(() => {
      const t = topic || "the following";
      return `Create a clear SVG diagram illustrating: ${t}`;
    });

    const response = generateText({
      system:
        "You create clear, well-structured SVG diagrams. Output a single <svg> element with an appropriate viewBox. Use shapes (rect, circle, ellipse), paths, lines, text, and arrows to illustrate concepts. Use readable fonts and clear colors. Output ONLY the SVG element with no surrounding explanation or markdown.",
      prompt,
      context,
    });

    return {
      [NAME]: computed(() => (topic ? `SVG Diagram: ${topic}` : "SVG Diagram")),
      [UI]: (
        <ct-screen>
          <ct-vstack slot="header" gap="1">
            <ct-heading level={4}>
              {computed(() => topic || "SVG Diagram")}
            </ct-heading>
          </ct-vstack>

          <ct-vstack gap="3" style="padding: 1.5rem;">
            {ifElse(
              response.pending,
              <div style="color: var(--ct-color-text-secondary);">
                <ct-loader show-elapsed /> Generating diagram...
              </div>,
              <ct-svg content={response.result} />,
            )}
          </ct-vstack>
        </ct-screen>
      ),
      topic,
      diagram: computed(() => response.result || ""),
      pending: response.pending,
    };
  },
);

export default SvgDiagram;
