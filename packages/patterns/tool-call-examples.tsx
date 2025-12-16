/// <cts-enable />
import { Cell, generateText, NAME, recipe, str, UI } from "commontools";

import { calculator } from "./common-tools.tsx";

export default recipe("ToolCallExamples", () => {
  const expression = Cell.of("1+1");

  const text = generateText({
    system:
      "You are a concise assistant. Call tools when you need precise data and reply with only the final answer.",
    prompt: str`Calculate: ${expression}`,
    tools: {
      calculator: {
        pattern: calculator,
      },
    },
  });

  return {
    [NAME]: "Tool Call Examples",
    [UI]: (
      <div>
        <div>
          <ct-input $value={expression} />
        </div>
        <div>
          <h2>Text Generation</h2>
          <p>{text.result}</p>
        </div>
      </div>
    ),
  };
});
