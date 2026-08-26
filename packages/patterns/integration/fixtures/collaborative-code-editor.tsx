import { Default, NAME, pattern, UI } from "commonfabric";

interface Input {
  content: string | Default<"">;
}

export default pattern<Input>(({ content }) => ({
  [NAME]: "Collaborative Code Editor Test",
  [UI]: (
    <div style={{ padding: "16px" }}>
      <cf-code-editor
        $value={content}
        collaborative
        language="text/markdown"
        style="min-height: 12rem;"
      />
      <div id="materialized-content">{content}</div>
    </div>
  ),
  content,
}));
