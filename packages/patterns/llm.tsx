/// <cts-enable />
import {
  Cell,
  cell,
  Default,
  derive,
  h,
  handler,
  llm,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

type LLMTestInput = {
  title: Default<string, "LLM Test">;
};

type LLMTestResult = {
  question: string;
  response?: string;
};

const askQuestion = handler<
  { detail: { message: string } },
  { question: Cell<string> }
>((event, { question }) => {
  const userQuestion = event.detail?.message?.trim();
  if (userQuestion) {
    question.set(userQuestion);
  }
});

export default recipe<LLMTestInput, LLMTestResult>("LLM Test", ({ title }) => {
  const question = cell<string>("");

  const llmResponse = llm({
    system:
      "You are a helpful assistant. Answer questions clearly and concisely.",
    messages: [question],
  });

  return {
    [NAME]: title,
    [UI]: (
      <div>
        <h2>{title}</h2>

        <div>
          <ct-message-input
            name="Ask"
            placeholder="Ask the LLM a question..."
            appearance="rounded"
            onct-send={askQuestion({ question })}
          />
        </div>

        {derive(question, (q) =>
          q
            ? (
              <div>
                <h3>Your Question:</h3>
                <blockquote>
                  {q}
                </blockquote>
              </div>
            )
            : null)}

        {derive(llmResponse.result, (r) =>
          r
            ? (
              <div>
                <h3>LLM Response:</h3>
                <pre>
                {r}
                </pre>
              </div>
            )
            : null)}
      </div>
    ),
    question,
    response: llmResponse.result,
  };
});
