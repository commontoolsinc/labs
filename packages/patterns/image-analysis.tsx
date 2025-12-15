/// <cts-enable />
import {
  Cell,
  derive,
  generateText,
  ImageData,
  NAME,
  recipe,
  UI,
  VNode,
} from "commontools";

/**
 * Image Chat - Simple image upload with LLM analysis
 */

type ImageChatInput = {
  systemPrompt?: string;
  model?: string;
};

type ImageChatOutput = {
  images: Cell<ImageData[]>;
  prompt: Cell<string>;
  response: string | undefined;
  pending: boolean | undefined;
  ui: VNode;
};

export default recipe<ImageChatInput, ImageChatOutput>(
  "Image Chat",
  ({ systemPrompt, model }) => {
    const images = Cell.of<ImageData[]>([]);
    const prompt = Cell.of<string>("");

    // Build content parts array with text and images
    const contentParts = derive(
      [prompt, images],
      ([promptText, imgs]: [string, ImageData[]]) => {
        const parts: Array<
          { type: "text"; text: string } | { type: "image"; image: string }
        > = [];

        if (promptText) {
          parts.push({ type: "text", text: promptText });
        }

        for (const img of imgs || []) {
          parts.push({ type: "image", image: img.data });
        }

        return parts;
      },
    );

    // Generate text from the content parts
    const { result, pending, requestHash } = generateText({
      system: derive(systemPrompt, (s) =>
        s ||
        "You are a helpful assistant that can analyze images. Describe what you see."),
      prompt: contentParts,
      model: derive(model, (m) => m || "anthropic:claude-sonnet-4-5"),
    });

    const ui = (
      <ct-screen>
        <ct-vstack slot="header" gap="2">
          <ct-heading level={4}>Image Chat</ct-heading>
        </ct-vstack>

        <ct-vscroll flex showScrollbar fadeEdges>
          <ct-vstack gap="3" style="padding: 1rem;">
            {/* Image Upload */}
            <ct-cell-context $cell={images} label="Uploaded Images">
              <ct-card>
                <ct-vstack gap="2">
                  <ct-heading level={5}>Upload Images</ct-heading>
                  <ct-image-input
                    multiple
                    maxImages={5}
                    showPreview
                    previewSize="md"
                    removable
                    $images={images}
                  />
                </ct-vstack>
              </ct-card>
            </ct-cell-context>

            {/* Prompt Input */}
            <ct-cell-context $cell={prompt} label="Image Prompt">
              <ct-card>
                <ct-vstack gap="2">
                  <ct-heading level={5}>Your Question</ct-heading>
                  <ct-input
                    $value={prompt}
                    placeholder="Ask about the images..."
                  />
                </ct-vstack>
              </ct-card>
            </ct-cell-context>

            {/* Response */}
            <ct-cell-context
              $cell={result as unknown as any}
              label="LLM Response"
            >
              {derive(
                [result, pending, requestHash],
                (
                  [res, pend, _hash]: [
                    string | undefined,
                    boolean | undefined,
                    string | undefined,
                  ],
                ) => {
                  if (pend) {
                    return (
                      <ct-card>
                        <div>Analyzing...</div>
                      </ct-card>
                    );
                  }

                  if (res) {
                    return (
                      <ct-card>
                        <ct-vstack gap="2">
                          <ct-heading level={5}>Response</ct-heading>
                          <div style="white-space: pre-wrap;">{res}</div>
                        </ct-vstack>
                      </ct-card>
                    );
                  }

                  return null;
                },
              )}
            </ct-cell-context>
          </ct-vstack>
        </ct-vscroll>
      </ct-screen>
    );

    return {
      [NAME]: "Image Chat",
      [UI]: ui,
      images,
      prompt,
      response: result,
      pending,
      ui,
    };
  },
);
