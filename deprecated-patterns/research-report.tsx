import { JSONSchema, NAME, pattern, UI } from "commontools";

const InputSchema = {
  type: "object",
  properties: {
    title: {
      type: "string",
      default: "Untitled Research Report",
      asCell: true,
    },
    content: {
      type: "string",
      default: "",
      asCell: true,
    },
  },
  required: ["content"],
} as const satisfies JSONSchema;

const OutputSchema = InputSchema;

export default pattern(
  InputSchema,
  OutputSchema,
  ({ title, content }: any) => {
    return {
      [NAME]: title,
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
              language="text/markdown"
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
