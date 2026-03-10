/// <cts-enable />
import { NAME, pattern, UI, type VNode, Writable } from "commontools";
import { Controls, SwitchControl } from "../ui/controls.tsx";

// deno-lint-ignore no-empty-interface
interface TextareaStoryInput {}
interface TextareaStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<TextareaStoryInput, TextareaStoryOutput>(() => {
  const disabled = Writable.of(false);

  return {
    [NAME]: "ct-textarea Story",
    [UI]: (
      <div
        style={{
          padding: "1rem",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
          maxWidth: "400px",
        }}
      >
        <ct-textarea
          placeholder="Default textarea"
          rows={3}
          disabled={disabled}
        />
        <ct-textarea placeholder="Auto-resize textarea" rows={2} auto-resize />
        <ct-textarea placeholder="Disabled" disabled rows={2} />
      </div>
    ),
    controls: (
      <Controls>
        <SwitchControl
          label="disabled"
          description="Disables interaction"
          defaultValue="false"
          checked={disabled}
        />
      </Controls>
    ),
  };
});
