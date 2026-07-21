import {
  computed,
  generateText,
  handler,
  ifElse,
  ImageData,
  isPending,
  NAME,
  pattern,
  resultOf,
  UI,
  VNode,
  Writable,
} from "commonfabric";

/**
 * Image Chat - Simple image upload with LLM analysis
 */

type ImageChatInput = {
  systemPrompt?: string;
  model?: string;
};

export type ImageChatOutput = {
  images: Writable<ImageData[]>;
  prompt: Writable<string>;
  response: string | undefined;
  pending: boolean | undefined;
  ui: VNode;
};

type ImageUploadEvent = {
  detail?: {
    images?: ImageData[];
    allImages?: ImageData[];
    files?: ImageData[];
    allFiles?: ImageData[];
  };
};

const syncUploadedImages = handler<
  ImageUploadEvent,
  { images: Writable<ImageData[]> }
>(({ detail }, { images }) => {
  const uploaded = detail?.allImages ?? detail?.allFiles ?? detail?.images ??
    detail?.files ?? [];
  images.set(uploaded);
});

export default pattern<ImageChatInput, ImageChatOutput>(
  ({ systemPrompt }) => {
    const images = new Writable<ImageData[]>([]);
    const prompt = new Writable<string>("");

    // Build content parts array with text and images
    const contentParts = computed(() => {
      const parts: Array<
        { type: "text"; text: string } | { type: "image"; image: string }
      > = [];

      if (prompt.get()) {
        parts.push({ type: "text", text: prompt.get() });
      }

      for (const img of images.get() || []) {
        const image = img.data || img.url;
        if (image) {
          parts.push({ type: "image", image });
        }
      }

      return parts;
    });

    // Generate text from the content parts
    const responseRequest = generateText({
      system: computed(() =>
        systemPrompt ||
        "You are a helpful assistant that can analyze images. Describe what you see."
      ),
      prompt: contentParts,
    });
    const result = resultOf(responseRequest);
    const pending = isPending(responseRequest);

    const ui = (
      <cf-screen>
        <cf-vstack slot="header" gap="2">
          <cf-heading level={4}>Image Chat</cf-heading>
        </cf-vstack>

        <cf-vscroll flex showScrollbar fadeEdges>
          <cf-vstack gap="3" style="padding: 1rem;">
            {/* Image Upload */}
            <cf-cell-context $cell={images} label="Uploaded Images">
              <cf-card>
                <cf-vstack gap="2">
                  <cf-heading level={5}>Upload Images</cf-heading>
                  <cf-image-input
                    multiple
                    maxImages={5}
                    includeData
                    showPreview
                    previewSize="md"
                    removable
                    oncf-change={syncUploadedImages({ images })}
                    oncf-remove={syncUploadedImages({ images })}
                  />
                </cf-vstack>
              </cf-card>
            </cf-cell-context>

            {/* Prompt Input */}
            <cf-cell-context $cell={prompt} label="Image Prompt">
              <cf-card>
                <cf-vstack gap="2">
                  <cf-heading level={5}>Your Question</cf-heading>
                  <cf-input
                    $value={prompt}
                    placeholder="Ask about the images..."
                  />
                </cf-vstack>
              </cf-card>
            </cf-cell-context>

            {/* Response */}
            {ifElse(
              pending,
              <cf-card>
                <div>Analyzing...</div>
              </cf-card>,
              ifElse(
                result,
                <cf-card>
                  <cf-vstack gap="2">
                    <cf-heading level={5}>Response</cf-heading>
                    <div style="white-space: pre-wrap;">{result}</div>
                  </cf-vstack>
                </cf-card>,
                null,
              ),
            )}
          </cf-vstack>
        </cf-vscroll>
      </cf-screen>
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
