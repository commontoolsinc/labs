import {
  ChatCompletionMessage,
  ChatCompletionMessageParam
} from "openai/resources/index.mjs";
import { client, grabJson, messageReducer, model } from "./llm.js";
import { recordThought, suggestions, updateThought } from "./model.js";
import { ReactiveGraph, Recipe } from "../data.js";
import { codePrompt } from "./implement.js";
import { describeTools, toolSpec } from "./tools.js";
import { LLMClient } from "@commontools/llm-client";
import { LLM_SERVER_URL } from "../llm-client.js";
import { appGraph } from "../components/com-app.js";
import { Graph } from "../reactivity/runtime.js";

type Conversation = ChatCompletionMessageParam[];

export async function plan(userInput: string, steps: string[]) {
  const logId = `plan[${userInput}]`;
  console.group(logId);

  if (steps.length === 0) {
    console.warn("No steps in plan");
    return;
  }
  const client = new LLMClient({
    serverUrl: LLM_SERVER_URL,
    tools: [],
    system: `${codePrompt} ${steps[0]}`
  });

  await recordThought({ role: "system", content: client.system });
  await recordThought({ role: "user", content: steps[1] });
  const thread = await client.createThread(steps[1]);
  await recordThought({
    role: "assistant",
    content: thread.conversation[thread.conversation.length - 1]
  });

  let idx = 2;

  let running = true;
  while (running) {
    const step = steps[idx];
    console.log("run step", idx, step);
    if (idx >= steps.length - 1) {
      running = false;
      break;
    }
    await recordThought({ role: "user", content: step });
    const message = await thread.sendMessage(step);
    await recordThought({ role: "assistant", content: message });
    idx++;
  }

  return thread.conversation;
}

export async function planGpt(userInput: string, steps: string[]) {
  const logId = `plan[${userInput}]`;
  console.group(logId);

  if (steps.length === 0) {
    console.warn("No steps in plan");
    return;
  }

  console.log(steps);

  let messages: ChatCompletionMessageParam[] = [
    { role: "system", content: codePrompt },
    { role: "system", content: steps[0] },
    { role: "user", content: steps[1] }
  ];

  await recordThought(messages[0]);
  await recordThought(messages[1]);

  let msgIdx = 1;

  let running = true;
  while (running) {
    const response = await client.chat.completions.create({
      messages,
      model,
      temperature: 0,
      stream: true
    });

    let message = {} as ChatCompletionMessage;
    const thoughtId = await recordThought(message);
    let finishReason = null as string | null;
    for await (const chunk of response) {
      finishReason ||= chunk.choices[0].finish_reason;
      message = messageReducer(message, chunk);
      await updateThought(thoughtId, message);
    }

    const latest = message;
    console.log("response", latest);
    messages.push(latest);

    if (msgIdx >= steps.length - 1) {
      running = false;
      break;
    }

    const nextStep: ChatCompletionMessageParam = {
      role: "user",
      content: steps[++msgIdx]
    };
    messages.push(nextStep);
    await recordThought(nextStep);
  }

  suggest(userInput, messages);

  console.groupEnd();
  return messages;
}

export async function suggest(input: string, fullPlan: Conversation) {
  const response = await client.chat.completions.create({
    messages: [
      ...fullPlan,
      {
        role: "user",
        content: `Based on the original user request (${input}) and the plan to service it, suggest 3 similar or related tasks the user might like to explore next. This could include tweaks to the existing UI, reusing the data in another context or a mix of both. Be concise, return a JSON array of strings with no more than 7 words per item.`
      }
    ],
    model,
    temperature: 0
  });

  recordThought(response.choices[0].message);
  const suggestionsText = response.choices[0].message.content;
  if (suggestionsText) {
    const data = grabJson(suggestionsText);
    suggestions.send(data);
  }

  return response.choices[0].message;
}

export function prepareSteps(userInput: string, graph: Graph) {
  if (graph.nodes.size === 0) {
    return [
      `You will create and modify software to solve a user's problems using a reactive graph computation model. Modules, a.k.a nodes, connect with each other, where the output of one or more nodes serves as the input to another. Available modules:

      ${describeTools(toolSpec, false)}

      To declare a constant value, return it from a code node as a literal.
      Declare event nodes and refer to them BY NAME from within UI template event bindings (i.e. "@click": "clickEvent").

      Plan your approach at a high-level dot-point level of detail and be extremely concise using technical terms.`,
      `Service the minimal useful version of this request: <user-request>${userInput}</user-request>.

    Give each node an ID and describe its purpose without writing the full code. Each node can have several named inputs which can be mapped to the outputs of other node ID.
    The output of all nodes must be used and all inputs must be mapped to valid outputs.

    When providing documentation and reasoning comments speak in an active voice about what you're accomplishing rather than explaining the nodes or talking about the graph.

    Provide your plan as a list of tool actions you intend to take on the graph.
    notalk;justgo
    `,
      `Reflect on the plan, does it make sense for a incredibly small immediately useful application? Can you implement it with these tools?

      ${describeTools(toolSpec, true)}

    Use pseudocode to sketch the technical approach. Write as concisely and accurately as possible without introducing assumptions or full specifying the details. Code nodes cannot mutate state, they are pure functions only. Do not attempt to model them as having side effects.
    Ensure all node are created in a logical order, so that the dependencies always exist. Start with fetching data, then processing, filtering, mapping and rendering.
    You must create a code node to declare constant values for code but NOT for shader uniforms. For static data you may inline constants into the code/shader nodes.

    Be creative in your examination of the tools, e.g. "show me myself" could be a shader using the webcam.

    Review the plan and make sure the user will be happy with the request: <user-request>${userInput}</user-request>
    notalk;justgo`
    ];
  } else {
    return [
      `Modify a reactive graph based application based on a user request.
      Modules, acting as nodes, connect with each other, where the output of one or more nodes serves as the input to another.

      Available modules:


    ${describeTools(toolSpec, true)}

    The current graph is:

    \`\`\`json
    ${JSON.stringify(appGraph.save(), null, 2)}
    \`\`\`

    <user-request>${userInput}</user-request>

    Explain which nodes will be altered, added or removed. Do not repeat the entire graph.
    Code nodes cannot mutate state, they are pure functions only.
    Do not attempt to model them as having side effects.
    notalk;justgo`,
      `Reflect on the plan. The user has requested a specific change. Do not overcomplicate it or add superfluous features. Just make the change.

      Recall the request: <user-request>${userInput}</user-request>`
    ];
  }
}
