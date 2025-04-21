import React from "react";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { markdown } from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";
import { json, jsonParseLinter } from "@codemirror/lang-json";

type EditorLanguage = "javascript" | "markdown" | "json";

export interface DocEditor {
  key: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  language: EditorLanguage;
  readOnly?: boolean;
}

interface Props {
  docs: DocEditor[];
  activeKey: string;
  onActiveKeyChange: (key: string) => void;
  loading?: boolean;
}

const CharmCodeEditor: React.FC<Props> = (
  { docs, activeKey, onActiveKeyChange, loading },
) => {
  const current = docs.find((d) => d.key === activeKey) || docs[0];
  const extensions = (() => {
    switch (current.language) {
      case "javascript":
        return [javascript()];
      case "markdown":
        return [markdown(), EditorView.lineWrapping];
      case "json":
        return [
          json(),
          EditorView.lineWrapping,
        ];
      default:
        return [];
    }
  })();
  const theme = current.language === "markdown" ? "light" : "dark";

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex items-center gap-4 p-4">
        {docs.map((d) => (
          <button
            key={d.key}
            type="button"
            onClick={() => onActiveKeyChange(d.key)}
            className={`px-2 py-1 text-xs border-2 ${
              activeKey === d.key
                ? "bg-gray-100 font-bold border-black"
                : "border-transparent"
            }`}
          >
            {d.label}
          </button>
        ))}
      </div>
      <div className="flex-grow overflow-hidden border-black border-2 h-full">
        <CodeMirror
          key={current.key}
          value={current.value}
          extensions={extensions}
          onChange={current.onChange}
          theme={theme}
          style={{ height: "100%", overflow: "auto" }}
          readOnly={loading || current.readOnly}
        />
      </div>
    </div>
  );
};

export default CharmCodeEditor;
