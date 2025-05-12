import { h } from "@commontools/html";
import {
  derive,
  JSONSchema,
  lift,
  llm,
  NAME,
  recipe,
  RecipeFactory,
  str,
  UI,
} from "@commontools/builder";
import { runtime } from "@commontools/runner";

// Define input schema
const InputSchema = {
  type: "object",
  properties: {
    task: {
      type: "string",
      title: "Task",
      description: "The task for the agent to complete",
      default: "Summarize the following text: Hello world, this is a test.",
    },
    maxSteps: {
      type: "number",
      title: "Max Steps",
      description:
        "Maximum number of steps the agent will take before stopping",
      default: 5,
    },
  },
  required: ["task", "maxSteps"],
} as const satisfies JSONSchema;

// Define output schema
const OutputSchema = {
  type: "object",
  properties: {
    result: {
      type: "string",
      description: "Final result from the agent",
    },
    messages: {
      type: "array",
      items: { type: "string" },
      description: "The internal reasoning and steps taken by the agent",
    },
  },
  required: ["result", "messages"],
} as const satisfies JSONSchema;

const codePrefix = `
import { lift, recipe, derive, handler, llm } from "@commontools/builder";
import { Result } from '../packages/memory/interface';

const math = lift((expression: string) => {
  return eval(expression);
});

const webresearch = lift((query: string) => {
  const call = llm({ messages: [query], model: "gpt-4o", stream: true });
  return call.result;
});

export default recipe("action", () =>
`;

const codePostfix = `
);
`;

const systemPrompt = `
You are a helpful assistant that can think and act.

Respond with a javascript snippet that calls the tools. Avoid any control flow or other logic, just call the function. Wrap the javascript snippet in <tool>...</tool> tags.

Tool responses are wrapped in <result>...</result> tags.

Available tools are:
 - math(expression: string) -> number // any valid javascript expression
 - webresearch(query: string) -> string // deep research, returns markdown

Example:
User:
What is 1 + 1?

Assistant:
<tool>
math("1 + 1")
</tool>

User:
<result>
2
</result>

Assistant:
The answer is 2.
`;

/**
 * Executes a single step of the agentic process.
 */
const step = recipe(
  {
    type: "object",
    properties: {
      messages: { type: "array", items: { type: "string" } },
      steps: { type: "number" },
    },
    required: ["messages", "steps"],
  } as const satisfies JSONSchema,
  {
    type: "object",
    properties: { messages: { type: "array", items: { type: "string" } } },
    required: ["messages"],
  } as const satisfies JSONSchema,
  ({ messages, steps }) => {
    const { result } = llm({
      messages,
      system: systemPrompt,
    });

    const actionResult = derive(result, async (result) => {
      if (!result) return undefined;

      const actionMatch = result.match(/<tool>(.*?)<\/tool>/is);
      const src = actionMatch?.[1].trim();
      if (!src) return undefined; // No action found, likely final response

      try {
        const code = codePrefix + src + codePostfix;
        const fn = await runtime.compile(code) as RecipeFactory<any, any>;
        if (!fn) return undefined;
        return fn(undefined);
      } catch (error) {
        console.error("error", error);
        if (error instanceof Error) {
          return `
Got an error:

${error.message}
${error.stack ?? ""}

Please try again.
`;
        }
        return `Error: ${error}`;
      }
    });

    // We need to wrap this in a derive that checks for undefined to wait for the
    // async calls above to finish. Ideally we do something `ifElse` like and pass
    // `step` into it, but right now that would always eagerly run the passed in
    // recipe anyway. We have to wait until the scheduler supports pull
    // scheduling.
    return derive(
      { messages, result, actionResult, steps },
      ({ messages, result, actionResult, steps }): { messages: string[] } => {
        if (!result) return { messages };
        if (!actionResult) return { messages: [...messages, result] };

        const nextMessages = [
          ...messages,
          result,
          str`<result>${actionResult}</result>`,
        ];
        if (steps <= 0) return { messages: nextMessages };

        return step({
          messages: nextMessages,
          steps: steps - 1,
        });
      },
    );
  },
);

const finalAnswer = lift((messages: string[]) => {
  if (!messages || !messages.length || messages.length % 2 === 1) {
    return undefined;
  }
  const lastMessage = messages[messages.length - 1];
  if (lastMessage.match(/<tool>(.*?)<\/tool>/is)) return undefined;
  else return lastMessage;
});

export default recipe(
  InputSchema,
  OutputSchema,
  ({ task, maxSteps }) => {
    const { messages } = step({
      messages: [task],
      steps: maxSteps,
    });

    const result = finalAnswer(messages);

    derive(result, (result) => result && console.log("Answer:", result));

    // Return the recipe
    return {
      [NAME]: str`Answering: ${task}`,
      [UI]: (
        <div>
          {messages.map((message) => <div>{message}</div>)}
        </div>
      ),
      messages,
      result,
    };
  },
);
