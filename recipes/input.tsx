import { h, handler, JSONSchema, NAME, recipe, UI } from "commontools";

const InputSchema = {
  type: "object",
  properties: {
    content: {
      type: "string",
      default: "",
    },
  },
  required: ["content"],
} as const satisfies JSONSchema;

const OutputSchema = InputSchema;

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
  ({ content }) => {
    return {
      [NAME]: "<ct-input /> test",
      [UI]: (
        <div style="padding: 1rem; max-width: 1200px; margin: 0 auto;">
          <ct-input
            $value={content}
            placeholder="Enter something..."
          />
        </div>
      ),
      content,
    };
  },
);
