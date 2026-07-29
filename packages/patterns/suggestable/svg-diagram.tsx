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

type SvgDiagramInput = {
  topic?: string | Default<"">;
  context?: Record<string, any> | Default<Record<string, never>>;
};

export type SvgDiagramOutput = {
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

    const responseRequest = generateText({
      system:
        "You create clear, well-structured SVG diagrams. Output a single <svg> element with an appropriate viewBox. Use shapes (rect, circle, ellipse), paths, lines, text, and arrows to illustrate concepts. Use readable fonts and clear colors. Output ONLY the SVG element with no surrounding explanation or markdown.",
      prompt,
      context,
    });
    const response = resultOf(responseRequest);

    return {
      [NAME]: computed(() => (topic ? `SVG Diagram: ${topic}` : "SVG Diagram")),
      [UI]: (
        <cf-screen>
          <cf-vstack slot="header" gap="1">
            <cf-heading level={4}>
              {computed(() => topic || "SVG Diagram")}
            </cf-heading>
          </cf-vstack>

          <cf-vstack gap="3" style="padding: 1.5rem;">
            {ifElse(
              isPending(responseRequest),
              <div style="color: var(--cf-theme-color-text-secondary);">
                <cf-loader show-elapsed /> Generating diagram...
              </div>,
              <cf-svg content={response} />,
            )}
          </cf-vstack>
        </cf-screen>
      ),
      topic,
      diagram: computed(() => response || ""),
      pending: isPending(responseRequest),
    };
  },
);

export default SvgDiagram;
