/// <cts-enable />
import {
  computed,
  generateText,
  ifElse,
  ImageData,
  NAME,
  pattern,
  UI,
  VNode,
  Writable,
} from "commontools";

/**
 * Image Chat - Simple image upload with LLM analysis
 */

type ImageChatInput = {
  systemPrompt?: string;
  model?: string;
};

type ImageChatOutput = {
  images: Writable<ImageData[]>;
  prompt: Writable<string>;
  response: string | undefined;
  pending: boolean | undefined;
  ui: VNode;
};

export default pattern<ImageChatInput, ImageChatOutput>(
  ({ systemPrompt, model }) => {
    const images = Writable.of<ImageData[]>([]);
    const prompt = Writable.of<string>("");

    // Build content parts array with text and images
    const contentParts = computed(() => {
      const parts: Array<
        { type: "text"; text: string } | { type: "image"; image: string }
      > = [];

      if (prompt.get()) {
        parts.push({ type: "text", text: prompt.get() });
      }

      for (const img of images.get() || []) {
        parts.push({ type: "image", image: img.data });
      }

      return parts;
    });

    // Generate text from the content parts
    const { result, pending, requestHash: _requestHash } = generateText({
      system: computed(() =>
        systemPrompt ||
        "You are a helpful assistant that can analyze images. Describe what you see."
      ),
      prompt: contentParts,
      model: computed(() => model || "anthropic:claude-sonnet-4-5"),
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
            {ifElse(
              pending,
              <ct-card>
                <div>Analyzing...</div>
              </ct-card>,
              ifElse(
                result,
                <ct-card>
                  <ct-vstack gap="2">
                    <ct-heading level={5}>Response</ct-heading>
                    <div style="white-space: pre-wrap;">{result}</div>
                  </ct-vstack>
                </ct-card>,
                null,
              ),
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
