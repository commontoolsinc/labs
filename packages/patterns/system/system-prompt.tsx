/// <cts-enable />
import {
  computed,
  type Default,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commontools";

interface Input {
  text?: Writable<Default<string, "">>;
}

/** #system prompt */
interface Output {
  [NAME]: string;
  [UI]: VNode;
  text: string;
  summary: string;
}

const SystemPrompt = pattern<Input, Output>(({ text }) => {
  const summary = computed(() => {
    const content = text.get();
    if (!content) return "";
    return content.length > 200 ? content.slice(0, 200) + "..." : content;
  });

  return {
    [NAME]: "System Prompt",
    [UI]: (
      <ct-screen>
        <ct-toolbar slot="header">
          <h2 slot="start">System Prompt</h2>
        </ct-toolbar>
        <ct-code-editor
          $value={text}
          language="text/markdown"
          theme="light"
          wordWrap
        />
      </ct-screen>
    ),
    text,
    summary,
  };
});

export default SystemPrompt;
