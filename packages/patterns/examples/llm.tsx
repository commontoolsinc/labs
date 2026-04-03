/// <cts-enable />
import {
  BuiltInLLMContent,
  Default,
  derive,
  generateText,
  handler,
  NAME,
  pattern,
  UI,
  Writable,
} from "commontools";

type LLMTestInput = {
  title: Default<string, "LLM Test">;
};

type LLMTestResult = {
  question: string;
  response?: BuiltInLLMContent;
};

const askQuestion = handler<
  { detail: { message: string } },
  { question: Writable<string> }
>((event, { question }) => {
  const userQuestion = event.detail?.message?.trim();
  if (userQuestion) {
    question.set(userQuestion);
  }
});

export default pattern<LLMTestInput>(({ title }) => {
  const question = Writable.of("");

  const llmResponse = generateText({
    system:
      "You are a helpful assistant. Answer questions clearly and concisely.",
    prompt: question,
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

        <ct-cell-context $cell={question}>
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
        </ct-cell-context>

        <ct-cell-context $cell={llmResponse}>
          {derive(
            [llmResponse.pending, llmResponse.result],
            ([pending, r]) =>
              pending
                ? (
                  <div>
                    <ct-loader show-elapsed /> Thinking...
                  </div>
                )
                : r
                ? (
                  <div>
                    <h3>LLM Response:</h3>
                    <pre>
                      {r}
                    </pre>
                  </div>
                )
                : null,
          )}
        </ct-cell-context>
      </div>
    ),
    question,
    response: llmResponse.result,
  };
});
