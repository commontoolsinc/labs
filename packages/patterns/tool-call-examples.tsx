/// <cts-enable />
import {
  Cell,
  generateObject,
  generateText,
  cell,
  handler,
  UI,
  computed,
  str,
  NAME,
  recipe,
} from "commontools";

import Chatbot from "./chatbot.tsx";
import { calculator } from "./common-tools.tsx"

const demoTool = handler<{ topic: string }, { }>(
  ({ topic }, _) => {
    console.log("topic passed", topic)
  },
);

export default recipe("ToolCallExamples", () => {
  const expression = cell("1+1")

  const text = generateText({
    system:
      "You are a concise assistant. Call tools when you need precise data and reply with only the final answer.",
    prompt:
      str`Calculate: ${expression}`,
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
    )
  };
});
