/// <cts-enable />
import {
  Cell,
  cell,
  derive,
  generateText,
  handler,
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

// Handler to update images
const handleImageChange = handler<
  { detail: { images: ImageData[] } },
  { images: Cell<ImageData[]> }
>((event, { images }) => {
  images.set(event.detail.images);
});

export default recipe<ImageChatInput, ImageChatOutput>(
  "Image Chat",
  ({ systemPrompt, model }) => {
    const images = cell<ImageData[]>([]);
    const prompt = cell<string>("");

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
            <ct-card>
              <ct-vstack gap="2">
                <ct-heading level={5}>Upload Images</ct-heading>
                <ct-image-input
                  multiple={true}
                  maxImages={5}
                  showPreview={true}
                  previewSize="md"
                  removable={true}
                  images={images}
                  onct-change={handleImageChange({ images })}
                />
              </ct-vstack>
            </ct-card>

            {/* Prompt Input */}
            <ct-card>
              <ct-vstack gap="2">
                <ct-heading level={5}>Your Question</ct-heading>
                <ct-input
                  $value={prompt}
                  placeholder="Ask about the images..."
                />
              </ct-vstack>
            </ct-card>

            {/* Response */}
            {derive(
              [result, pending, requestHash],
              (
                [res, pend, hash]: [
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
