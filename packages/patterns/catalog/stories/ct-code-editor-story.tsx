/// <cts-enable />
import { NAME, pattern, UI, type VNode, Writable } from "commontools";
import { Controls, SelectControl, SwitchControl } from "../ui/controls.tsx";

// deno-lint-ignore no-empty-interface
interface CodeEditorStoryInput {}
interface CodeEditorStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<CodeEditorStoryInput, CodeEditorStoryOutput>(() => {
  const value = Writable.of(
    `function greet(name: string) {\n  return \`Hello, \${name}!\`;\n}\n\ngreet("CommonTools");\n`,
  );
  const language = Writable.of<
    | "text/javascript"
    | "text/markdown"
    | "application/json"
    | "text/css"
    | "text/html"
    | "text/x.jsx"
    | "text/x.typescript"
  >("text/javascript");
  const disabled = Writable.of(false);
  const readonly = Writable.of(false);
  const lineNumbers = Writable.of(true);
  const wordWrap = Writable.of(true);

  return {
    [NAME]: "ct-code-editor Story",
    [UI]: (
      <div style={{ padding: "1rem" }}>
        <div style={{ height: "320px", border: "1px solid #e2e8f0" }}>
          <ct-code-editor
            $value={value}
            language={language}
            disabled={disabled}
            readonly={readonly}
            lineNumbers={lineNumbers}
            wordWrap={wordWrap}
            placeholder="Enter code..."
            style="height: 100%;"
          />
        </div>
      </div>
    ),
    controls: (
      <Controls>
        <>
          <SelectControl
            label="language"
            description="Editor syntax mode (MIME)"
            defaultValue="text/javascript"
            value={language}
            items={[
              { label: "JavaScript", value: "text/javascript" },
              { label: "TypeScript", value: "text/x.typescript" },
              { label: "JSX", value: "text/x.jsx" },
              { label: "Markdown", value: "text/markdown" },
              { label: "JSON", value: "application/json" },
              { label: "CSS", value: "text/css" },
              { label: "HTML", value: "text/html" },
            ]}
          />
          <SwitchControl
            label="disabled"
            description="Disables editor interaction"
            defaultValue="false"
            checked={disabled}
          />
          <SwitchControl
            label="readonly"
            description="Locks editing but keeps selection/copy"
            defaultValue="false"
            checked={readonly}
          />
          <SwitchControl
            label="lineNumbers"
            description="Shows line number gutter"
            defaultValue="true"
            checked={lineNumbers}
          />
          <SwitchControl
            label="wordWrap"
            description="Soft wrap long lines"
            defaultValue="true"
            checked={wordWrap}
          />
        </>
      </Controls>
    ),
  };
});
