/// <cts-enable />
import {
  BuiltInLLMContent,
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

// this basic pattern already exists as llm.tsx
// wanting to modify for the next few items:
// TODO(@ellyxir): turn derive into lift() hoping that this will
// remove the weird wrapper around llmResponse.result
// TODO(@ellyxir): make cell() a default
// TODO(@ellyxir): show when result is pending
// TODO(@ellyxir): clean up UI a bit

type InputType = {
  title: Default<string, "MyLLM">;
};

type OutputType = {
  userMessage: string;
  response?: BuiltInLLMContent;
};

const textInputHandler = handler<
  { detail: { message: string } },
  { userMessage: Cell<string> }
>(({ detail: { message } }, { userMessage }) => {
  userMessage.set(message);
});

export default recipe<InputType, OutputType>("LLM Test", ({ title }) => {
  const userMessage = cell<string>(undefined);

  // returns OpaqueRef<BuiltInLLMState>:
  // export interface BuiltInLLMState {
  //   pending: boolean;
  //   result?: BuiltInLLMContent;
  //   partial?: string;
  //   error: unknown;
  //   cancelGeneration: Stream<void>;
  // }
  const llmResponse = llm({
    system:
      "You are a helpful assistant. Answer questions clearly and concisely.",
    messages: derive(userMessage, (msg) =>
      msg
        ? [{
          role: "user",
          content: msg,
        }]
        : []),
  });

  return {
    [NAME]: "MyLLM test",
    [UI]: (
      <div>
        <h2>{title}</h2>
        <div>
          llmResponse using curly braces:
          {derive(llmResponse.result, (res) => res ? JSON.stringify(res) : "")}
        </div>
        <div>User Message: {userMessage}</div>
        <div>
          <common-send-message
            name="Send"
            placeholder="Type a message..."
            appearance="rounded"
            onmessagesend={textInputHandler({ userMessage })}
          />
        </div>
      </div>
    ),
    userMessage,
    response: llmResponse.result,
  };
});
