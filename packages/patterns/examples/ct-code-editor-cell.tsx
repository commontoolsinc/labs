/// <cts-enable />
/**
 * Integration test example for ct-code-editor with Cell binding.
 * Used to test cursor stability when typing with Cell sync.
 */
import { Cell, Default, NAME, pattern, UI } from "commontools";

interface Input {
  content: Default<string, "">;
}

export default pattern<Input>(({ content }) => {
  return {
    [NAME]: "Code Editor Test",
    [UI]: (
      <div
        id="test-container"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "16px",
          padding: "16px",
        }}
      >
        <h2>Code Editor Cursor Test</h2>
        <div
          id="editor-container"
          style={{
            border: "1px solid #ccc",
            borderRadius: "8px",
            minHeight: "200px",
          }}
        >
          <ct-code-editor $value={content} language="text/markdown" />
        </div>
        <div id="content-display" style={{ padding: "8px", background: "#f5f5f5" }}>
          Content: {content}
        </div>
      </div>
    ),
    content,
  };
});
