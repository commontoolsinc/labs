import { h, handler, JSONSchema, NAME, recipe, UI } from "commontools";

const InputSchema = {
  type: "object",
  properties: {
    title: {
      type: "string",
      default: "Untitled Research Report",
    },
    content: {
      type: "string",
      default: "",
    },
  },
  required: ["title", "content"],
} as const satisfies JSONSchema;

const OutputSchema = InputSchema;

const updateTitle = handler<{ detail: { value: string } }, { title: string }>(
  (event, state) => {
    state.title = event.detail?.value ?? "";
  },
);

const updateContent = handler<
  { detail: { value: string } },
  { content: string }
>(
  (event, state) => {
    state.content = event.detail?.value ?? "";
  },
);

export default recipe(
  InputSchema,
  OutputSchema,
  ({ title, content }) => {
    return {
      [NAME]: title || "Untitled Research Report",
      [UI]: (
        <div style="padding: 1rem; max-width: 1200px; margin: 0 auto;">
          <div style="margin-bottom: 1rem;">
            <ct-input
              $value={title}
              placeholder="Enter research report title..."
              style="width: 100%; font-size: 1.2rem; font-weight: bold;"
            />
          </div>
          <div style="border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
            <ct-code-editor
              $value={content}
              language="text/plain"
              style="min-height: 400px;"
            />
          </div>
        </div>
      ),
      title,
      content,
    };
  },
);
