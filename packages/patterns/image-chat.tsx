/// <cts-enable />
import {
  BuiltInLLMMessage,
  Cell,
  cell,
  derive,
  generateText,
  handler,
  NAME,
  recipe,
  Stream,
  UI,
  VNode,
} from "commontools";
import type { ImageData } from "@commontools/ui";

/**
 * Image Chat - Demonstrates image upload, storage, rendering, and LLM integration
 *
 * This pattern shows how to:
 * 1. Upload images using ct-image-input
 * 2. Store images in cells as base64-encoded ImageData
 * 3. Render images from cells
 * 4. Pass images to LLM calls (generateText, generateObject, llm, llmDialog)
 */

type ImageChatInput = {
  systemPrompt?: string;
  model?: string;
};

type ImageChatOutput = {
  images: Cell<ImageData[]>;
  messages: Cell<BuiltInLLMMessage[]>;
  userPrompt: Cell<string>;
  response: string | undefined;
  pending: boolean | undefined;
  ui: VNode;
};

// Handler for when images are uploaded via ct-image-input
const handleImageChange = handler<
  { detail: { images: ImageData[] } },
  { images: Cell<ImageData[]> }
>((event, { images }) => {
  const newImages = event.detail.images;
  images.set(newImages);
});

// Handler for sending a message with images to the LLM
const handleSendMessage = handler<
  { detail: { prompt: string } },
  {
    images: Cell<ImageData[]>;
    messages: Cell<BuiltInLLMMessage[]>;
    userPrompt: Cell<string>;
    sendMessage: Stream<void>;
  }
>((event, { images, messages, userPrompt, sendMessage }) => {
  const prompt = event.detail.prompt.trim();
  const currentImages = images.get() || [];

  if (!prompt && currentImages.length === 0) return;

  // Update the user prompt cell
  userPrompt.set(prompt);

  // Build message content with text and images
  const contentParts: Array<
    { type: "text"; text: string } | { type: "image"; image: string }
  > = [];

  // Add text if provided
  if (prompt) {
    contentParts.push({ type: "text", text: prompt });
  }

  // Add all images as image parts
  for (const image of currentImages) {
    contentParts.push({
      type: "image",
      image: image.data, // Use the base64 data URL
    });
  }

  // Add user message to history
  const currentMessages = messages.get() || [];
  messages.set([
    ...currentMessages,
    {
      role: "user",
      content: contentParts,
    },
  ]);

  // Trigger the LLM call
  sendMessage.send();
});

// Handler for clearing the chat
const handleClear = handler<
  never,
  {
    images: Cell<ImageData[]>;
    messages: Cell<BuiltInLLMMessage[]>;
    userPrompt: Cell<string>;
  }
>((_event, { images, messages, userPrompt }) => {
  images.set([]);
  messages.set([]);
  userPrompt.set("");
});

export default recipe<ImageChatInput, ImageChatOutput>(
  "Image Chat",
  ({ systemPrompt, model }) => {
    // State cells
    const images = cell<ImageData[]>([]);
    const messages = cell<BuiltInLLMMessage[]>([]);
    const userPrompt = cell<string>("");
    const sendMessage = cell<Stream<void>>();

    // Build prompt for LLM with images
    const llmPrompt = derive(
      [userPrompt, images],
      ([prompt, imgs]: [string, ImageData[]]) => {
        if (!prompt && (!imgs || imgs.length === 0)) return "";

        const parts: Array<
          { type: "text"; text: string } | { type: "image"; image: string }
        > = [];

        if (prompt) {
          parts.push({ type: "text", text: prompt });
        }

        for (const img of imgs || []) {
          parts.push({ type: "image", image: img.data });
        }

        return parts;
      },
    );

    // LLM call using generateText
    const { result, pending } = generateText({
      system: systemPrompt || "You are a helpful assistant that can analyze images. Describe what you see in the images and answer questions about them.",
      prompt: llmPrompt,
      model: model || "anthropic:claude-sonnet-4-5",
      trigger: sendMessage,
    });

    // Add assistant response to messages when it arrives
    const messagesWithResponse = derive(
      [messages, result],
      ([msgs, response]: [BuiltInLLMMessage[], string | undefined]) => {
        if (!response) return msgs;

        // Check if the last message is already the assistant response
        const lastMessage = msgs[msgs.length - 1];
        if (
          lastMessage?.role === "assistant" &&
          lastMessage?.content === response
        ) {
          return msgs;
        }

        return [
          ...msgs,
          {
            role: "assistant" as const,
            content: response,
          },
        ];
      },
    );

    // UI layout
    const ui = (
      <ct-screen>
        <ct-vstack slot="header" gap="2">
          <ct-heading level={4}>Image Chat Example</ct-heading>
          <ct-label>
            Upload images and ask questions about them
          </ct-label>
        </ct-vstack>

        <ct-vscroll flex showScrollbar fadeEdges>
          <ct-vstack gap="3" style="padding: 1rem;">
            {/* Image Upload Section */}
            <ct-card>
              <ct-vstack gap="2">
                <ct-heading level={5}>Upload Images</ct-heading>
                <ct-image-input
                  multiple={true}
                  maxImages={5}
                  showPreview={true}
                  previewSize="md"
                  removable={true}
                  onct-change={handleImageChange({ images })}
                />
              </ct-vstack>
            </ct-card>

            {/* Current Images Display */}
            {derive(images, (imgs) => {
              if (!imgs || imgs.length === 0) return null;

              return (
                <ct-card>
                  <ct-vstack gap="2">
                    <ct-heading level={5}>
                      Selected Images ({imgs.length})
                    </ct-heading>
                    <ct-hstack gap="2" wrap>
                      {imgs.map((img) => (
                        <ct-vstack gap="1" key={img.id}>
                          <img
                            src={img.url}
                            alt={img.name}
                            style="max-width: 200px; max-height: 200px; object-fit: contain; border-radius: 4px; border: 1px solid var(--ct-theme-color-border, #e5e7eb);"
                          />
                          <ct-label style="font-size: 0.75rem; text-align: center;">
                            {img.name}
                          </ct-label>
                        </ct-vstack>
                      ))}
                    </ct-hstack>
                  </ct-vstack>
                </ct-card>
              );
            })}

            {/* Messages Display */}
            {derive(messagesWithResponse, (msgs) => {
              if (!msgs || msgs.length === 0) return null;

              return (
                <ct-card>
                  <ct-vstack gap="2">
                    <ct-heading level={5}>Conversation</ct-heading>
                    <ct-vstack gap="2">
                      {msgs.map((msg, idx) => (
                        <ct-card
                          key={idx}
                          variant={msg.role === "user" ? "outline" : "default"}
                        >
                          <ct-vstack gap="1">
                            <ct-label style="font-weight: 600; text-transform: capitalize;">
                              {msg.role}
                            </ct-label>
                            <div style="white-space: pre-wrap;">
                              {typeof msg.content === "string"
                                ? msg.content
                                : msg.content
                                    .filter((part) => part.type === "text")
                                    .map((part) =>
                                      part.type === "text" ? part.text : ""
                                    )
                                    .join(" ")}
                            </div>
                          </ct-vstack>
                        </ct-card>
                      ))}
                    </ct-vstack>
                  </ct-vstack>
                </ct-card>
              );
            })}

            {/* Pending Indicator */}
            {derive(pending, (p) => {
              if (!p) return null;
              return (
                <ct-card>
                  <ct-label>Analyzing images...</ct-label>
                </ct-card>
              );
            })}
          </ct-vstack>
        </ct-vscroll>

        {/* Input Footer */}
        <ct-vstack slot="footer" gap="2" style="padding: 1rem;">
          <ct-hstack gap="2" align="center">
            <ct-input
              $value={userPrompt}
              placeholder="Ask a question about the images..."
              flex
              onkeydown={(e: KeyboardEvent) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  const prompt = userPrompt.get();
                  handleSendMessage({
                    images,
                    messages,
                    userPrompt,
                    sendMessage,
                  })({ detail: { prompt } });
                }
              }}
            />
            <ct-button
              variant="primary"
              disabled={pending}
              onClick={() => {
                const prompt = userPrompt.get();
                handleSendMessage({
                  images,
                  messages,
                  userPrompt,
                  sendMessage,
                })({ detail: { prompt } });
              }}
            >
              Send
            </ct-button>
            <ct-button
              variant="outline"
              onClick={handleClear({ images, messages, userPrompt })}
            >
              Clear
            </ct-button>
          </ct-hstack>
        </ct-vstack>
      </ct-screen>
    );

    return {
      [NAME]: "Image Chat",
      [UI]: ui,
      images,
      messages,
      userPrompt,
      response: result,
      pending,
      ui,
    };
  },
);
