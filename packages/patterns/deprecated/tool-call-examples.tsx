import {
  generateText,
  NAME,
  pattern,
  resultOf,
  str,
  UI,
  Writable,
} from "commonfabric";

import { calculator } from "../system/common-fabric.tsx";

export default pattern(() => {
  const expression = Writable.of("1+1");

  const textRequest = generateText({
    system:
      "You are a concise assistant. Call tools when you need precise data and reply with only the final answer.",
    prompt: str`Calculate: ${expression}`,
    tools: {
      calculator: {
        pattern: calculator,
      },
    },
  });
  const text = resultOf(textRequest);

  return {
    [NAME]: "Tool Call Examples",
    [UI]: (
      <div>
        <div>
          <cf-input $value={expression} />
        </div>
        <div>
          <h2>Text Generation</h2>
          <p>{text}</p>
        </div>
      </div>
    ),
  };
});
