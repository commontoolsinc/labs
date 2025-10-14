/// <cts-enable />
import {
  BuiltInLLMContent,
  Cell,
  cell,
  Default,
  derive,
  handler,
  llm,
  NAME,
  recipe,
  UI,
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
  { question: Cell<string> }
>((event, { question }) => {
  const userQuestion = event.detail?.message?.trim();
  if (userQuestion) {
    question.set(userQuestion);
  }
});

export default recipe<LLMTestInput, LLMTestResult>("LLM Test", ({ title }) => {
  // It is possible to make inline cells like this, but always consider whether it should just be part of the argument cell.
  // These cells are effectively 'hidden state' from other recipes
  const question = cell<string>("");

  const llmResponse = llm({
    system:
      "You are a helpful assistant. Answer questions clearly and concisely.",
    messages: derive(question, (q) => q ? [{ role: "user", content: q }] : []),
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
                  {JSON.stringify(r, null, 2)}
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
