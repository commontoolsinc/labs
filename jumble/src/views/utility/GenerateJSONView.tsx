import { useState } from "react";
import { generateJSON } from "@commontools/llm";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { DEFAULT_MODEL_NAME } from "@commontools/llm/types";

export default function LLMTestView() {
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    setLoading(true);
    try {
      const response = await generateJSON(prompt, DEFAULT_MODEL_NAME);
      setResult(JSON.stringify(response, null, 2));
    } catch (error) {
      console.error("Error generating JSON:", error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-gray-50 border-2 border-black max-w-4xl mx-auto p-6 space-y-6">
      <h1 className="text-2xl font-bold">LLM Prompt Testing</h1>

      <div className="space-y-4">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.metaKey && e.key === "Enter") {
              e.preventDefault();
              if (!loading && prompt.trim()) {
                handleSubmit();
              }
            }
          }}
          placeholder="Enter your prompt here..."
          className="w-full h-48 p-4 border-2 border-black font-mono text-sm"
        />

        <button
          type="button"
          onClick={handleSubmit}
          disabled={loading || !prompt.trim()}
          className="px-4 py-2 bg-black text-white hover:bg-gray-800 disabled:opacity-50"
        >
          {loading ? "Generating..." : "Generate JSON"}
        </button>
      </div>

      {result && (
        <div className="mt-8">
          <h2 className="text-xl font-semibold mb-4">Result:</h2>
          <CodeMirror
            value={result}
            theme="dark"
            extensions={[javascript()]}
            editable
          />;
        </div>
      )}
    </div>
  );
}
