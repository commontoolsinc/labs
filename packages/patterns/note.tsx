/// <cts-enable />
import {
  Cell,
  Default,
  h,
  handler,
  NAME,
  recipe,
  toSchema,
  UI,
} from "commontools";

type Input = {
  title: Default<string, "Untitled Note">;
  content: Default<string, "">;
};

type Output = Input;

const updateTitle = handler<
  { detail: { value: string } },
  { title: Cell<string> }
>(
  (event, state) => {
    state.title.set(event.detail?.value ?? "");
  },
);

const updateContent = handler<
  { detail: { value: string } },
  { content: Cell<string> }
>(
  (event, state) => {
    state.content.set(event.detail?.value ?? "");
  },
);

export default recipe<Input, Output>(
  "Note",
  ({ title, content }) => {
    return {
      [NAME]: title,
      [UI]: (
        <ct-screen>
          <div slot="header">
            <ct-input
              $value={title}
              placeholder="Enter title..."
            />
          </div>
          <ct-code-editor
            $value={content}
            language="text/markdown"
            style="min-height: 400px;"
          />
        </ct-screen>
      ),
      title,
      content,
    };
  },
);
