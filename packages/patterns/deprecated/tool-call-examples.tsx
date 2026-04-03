/// <cts-enable />
import { generateText, NAME, pattern, str, UI, Writable } from "commontools";

import { calculator } from "../system/common-tools.tsx";

export default pattern(() => {
  const expression = Writable.of("1+1");

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
