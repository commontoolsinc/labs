import {
  ChatCompletionMessage,
  ChatCompletionMessageParam
} from "openai/resources/index.mjs";
import { client, grabJson, messageReducer, model } from "./llm.js";
import { recordThought, suggestions, updateThought } from "./model.js";
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

  recordThought({
    role: "assistant",
    content: response.choices[0].message.content!
  });
  const suggestionsText = response.choices[0].message.content;
  if (suggestionsText) {
    const data = grabJson(suggestionsText);
    suggestions.send(data);
  }

  return response.choices[0].message;
}

export function sketchHighLevelApproachPrompt(userInput: string) {
  return {
    system: `You will create a specification for an ephemeral software application. We will start at a high level, natural language sketch of the approach.

      The environment is a reactive graph computation model. Modules, a.k.a nodes, connect with each other, where the output of one or more nodes serves as the input to another. Available modules include:

      - data nodes to store state
      - mapping functions to apply pure transformations to data
      - event listener nodes to respond to user input
      - UI nodes to render the data (html, svg, vega-lite, voxels, etc.)
      - effect nodes to access http, language models, databases, etc.

      Each node has one or more inputs and a single output. Plan your approach in a document format like so:

      <user-request>Make a counter with a button</user-request>

      <plan>
        <prompt>Make a counter with a button</prompt>
        <step>Declare the counter, default to 0</step>
        <step>Create a button, label it "increment", on click it dispatches an event named "clicked"</step>
        <step>Add an event handler to listen for "clicked" and increment the counter</step>
        <step>Create a text node to display the counter value</step>
      </plan>

      <user-request>Make a voxel sphere</user-request>

      <plan>
        <prompt>Make a voxel sphere</prompt>
        <step>Declare a variable for sphere radius</step>
        <step>Declare a function to generate the voxels for a sphere</step>
        <step>Create a UI (voxel) node to display the geometry</step>
      </plan>

      Be clear but concise, using technical terms. Every word is a wasted moment for the user but they must understand your reasoning.`,

    prompt: `Service the minimal useful version of this request: <user-request>${userInput}</user-request>.`
  };
}

export function planIdentifiers(step: string, userInput: string) {
  return {
    system: `You will enrich a specification for an ephemeral software application by detailing components needed to implement it.

      The environment is a reactive graph computation model. Modules, a.k.a nodes, connect with each other, where the output of one or more nodes serves as the input to another. Available modules include:

      ${describeTools(toolSpec, false)}

      Each node has one or more inputs and a single output. You will work step by step and enrich a loose plan, so for an example plan:

      <plan>
        <prompt>Counter with button</prompt>
        <step>Declare the counter, default to 0</step>
        <step>Create a button, label it "increment", on click it dispatches an event named "clicked"</step>
        <step>Add an event handler to listen for "clicked" and increment the counter</step>
        <step>Create a text node to display the counter value</step>
      </plan>

      If we are implementing the first step, you would enrich it with identifiers like so:

      <result>
        <step>Declare the counter, default to 0</step>
        <identifier>counter = 0</identifier>
      </result>

      or, for the second step:

      <result>
        <step>Create a button, label it "increment", on click it dispatches an event named "clicked"</step>
        <identifier>button({ label: "increment", "@click": "clicked"})</identifier>
      </result>

      Another example plan:

      <plan>
        <prompt>Make a sphere</prompt>
        <step>Declare a variable for sphere radius</step>
        <step>Declare a function to generate the voxels for a sphere</step>
        <step>Create a UI (voxel) node to display the geometry</step>
      </plan>

      The second step would be enriched like so:

      <result>
        <step>Declare a function to generate the voxels for a sphere</step>
        <step>function generateSphereVoxels(radius) {}</step>
      </result>

      Avoid fully specifying function bodies, but feel free sketch the implementation or leave a clarifying comment for later.

      You will receive a single <step>, return the enriched version within a <result> tag.

      <user-request>${userInput}</user-request>`,

    prompt: step
  };
}

export function makeConsistent(plan: string) {
  return {
    system: `You will audit and fix a specification for an ephemeral software application. The plan consists of a natural language description of the approach and a psuedocode sketch of the various elements.

      The environment is a reactive graph computation model. Modules, a.k.a nodes, connect with each other, where the output of one or more nodes serves as the input to another. Available modules include:

      - data nodes to store state
      - mapping functions to apply pure transformations to data
      - event listener nodes to respond to user input
      - UI nodes to render the data (html, svg, vega-lite, voxels, etc.)
      - effect nodes to access http, language models, databases, etc.

      Each node has one or more inputs and a single output.

      You will receive a <plan> tag.

      It may have inconsistencies, like a missing step, a step out of order, mismatched identifiers or a decoupling of the step from the psuedocode.

      <plan>
        <prompt>Flip a coin</prompt>
        <step>Create a data node to store the coin state (heads or tails)</step>
        <identifier>coinState = "tails"</identifier>
        <step>Add a button UI node labeled "Flip Coin"</step>
        <identifier>button({ label: "Do it!", "@click": "flipCoin" })</identifier>
        <step>Create an event listener for the button click</step>
        <identifier>on("clicked", () => {})</identifier>
        <step>On click, use a mapping function to randomly set the coin state</step>
        <identifier>coinState = map( () => Math.random() < 0.5 ? 'heads' : 'tails', clickEvent )</identifier>
        <step>Display the current coin state with a text UI node</step>
        <identifier>text(coin_state)</identifier>
      </plan>

      You will return a corrected version of the plan within a <corrected-plan> tag:

      <corrected-plan>
        <prompt>Flip a coin</prompt>
        <step>Create a data node to store the coin state (heads or tails)</step>
        <identifier>coinState = "tails"</identifier>
        <step>Add a button UI node labeled "Do it!"</step>
        <identifier>addButton = button({ label: "Do it!", "@click": "clicked" })</identifier>
        <step>Create an event listener for the button click and update the coin state</step>
        <identifier>flipCoin = on("clicked", () => Math.random() < 0.5 ? 'heads' : 'tails')</identifier>
        <connection>flipCoin -> coinState</connection>
        <step>Display the current coin state with a text UI node</step>
        <identifier>text(coinState)</identifier>
        <connection>coinState -> text.coinState</connection>
      </corrected-plan>

      Be clear but concise, using technical terms. Every word is a wasted moment for the user but they must understand your reasoning.

      Take extra care not to bloat the request beyond the original scope, implement the MVP that satisfies the user request.
      `,

    prompt: plan
  };
}

export function prepareSteps(userInput: string, graph: Graph) {
  if (graph.nodes.size === 0) {
    return [
      `You will create and modify software to solve a user's problems using a reactive graph computation model. Modules, a.k.a nodes, connect with each other, where the output of one or more nodes serves as the input to another. Available modules:

      ${describeTools(toolSpec, false)}

      To declare a constant value, return it from a code node as a literal.
      Declare event nodes and refer to them BY NAME from within UI template event bindings (i.e. "@click": "clickEvent").

      Plan your approach at a high-level dot-point level of detail and be extremely concise using technical terms.  Be extremely concise in your language, use technical terse speech with abbreviations. Every word is a wasted moment for the user.`,
      `Service the minimal useful version of this request: <user-request>${userInput}</user-request>.

    Give each node an ID and describe its purpose without writing the full code. Each node can have several named inputs which can be mapped to the outputs of other node ID.
    The output of all nodes must be used and all inputs must be mapped to valid outputs.

    When providing documentation and reasoning comments speak in an active voice about what you're accomplishing rather than explaining the nodes or talking about the graph.

    Provide your plan as a list of tool actions you intend to take on the graph.
     Be extremely concise in your language, use technical terse speech with abbreviations. Every word is a wasted moment for the user.
    notalk;justgo
    `,
      `Reflect on the plan, does it make sense for a incredibly small immediately useful application? Can you implement it with these tools?

      ${describeTools(toolSpec, true)}

    Use pseudocode to sketch the technical approach. Write as concisely and accurately as possible without introducing assumptions or full specifying the details. Code nodes cannot mutate state, they are pure functions only. Do not attempt to model them as having side effects.
    Ensure all node are created in a logical order, so that the dependencies always exist. Start with fetching data, then processing, filtering, mapping and rendering.
    You must create a code node to declare constant values for code but NOT for shader uniforms. For static data you may inline constants into the code/shader nodes.

    Be creative in your examination of the tools, e.g. "show me myself" could be a shader using the webcam.

    Review the plan and make sure the user will be happy with the request: <user-request>${userInput}</user-request>
     Be extremely concise in your language, use technical terse speech with abbreviations. Every word is a wasted moment for the user.
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
     Be extremely concise in your language, use technical terse speech with abbreviations. Every word is a wasted moment for the user.
    notalk;justgo`,
      `Reflect on the plan. The user has requested a specific change. Do not overcomplicate it or add superfluous features. Just make the change.

      Recall the request: <user-request>${userInput}</user-request>
       Be extremely concise in your language, use technical terse speech with abbreviations. Every word is a wasted moment for the user.`
    ];
  }
}
