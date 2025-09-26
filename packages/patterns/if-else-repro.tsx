/// <cts-enable />
import {
  BuiltInLLMMessage,
  Cell,
  cell,
  Default,
  derive,
  fetchData,
  getRecipeEnvironment,
  h,
  handler,
  ID,
  ifElse,
  JSONSchema,
  lift,
  llm,
  llmDialog,
  NAME,
  navigateTo,
  OpaqueRef,
  recipe,
  str,
  Stream,
  UI,
} from "commontools";

type Charm = {
  [NAME]: string;
  content?: string;
  mentioned?: Charm[];
};

type LLMTestInput = {
  title: Default<string, "LLM Test">;
  expandChat: Default<boolean, false>;
};

type LLMTestResult = {};

export default recipe<LLMTestInput, LLMTestResult>(
  "Note",
  ({ title, expandChat }) => {
    const optionA = derive(expandChat, (t) => t ? "A" : "a");
    const optionB = derive(expandChat, (t) => t ? "B" : "b");

    return {
      [NAME]: title,
      [UI]: (
        <ct-screen>
          <ct-hstack justify="between" slot="header">
            <div></div>
            <div>
              <ct-checkbox $checked={expandChat}>Toggle</ct-checkbox>
            </div>
          </ct-hstack>

          {/* FAIL: renders 'b' on launch, renders 'B' on toggle (this should be impossible) and then crashes on next toggle */}
          {ifElse(
            expandChat,
            optionA,
            optionB,
          )}

          {/* FAIL: literally renders: {"children":{"cell":{"/":"baedreiaed62g7rk5i67w4cs2fvnfw2kkrl7vxqjz5ihjhop3yhcql6cwia"},"path":["children"]}} */}
          {
            /*{derive(
            { optionA, optionB, expandChat },
            ({ optionA, optionB, expandChat }) =>
              expandChat ? optionA : optionB,
          )}*/
          }

          {/* FAIL: renders TWO copies of the same thing, e.g. "bb" or "AA" but DOES toggle between the options */}
          {
            /*{lift(({ expandChat, optionA, optionB }) => {
            return expandChat ? optionA : optionB;
          })({ expandChat, optionA, optionB })}*/
          }
        </ct-screen>
      ),
    };
  },
);
