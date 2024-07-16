import {
  ChatCompletionMessage,
  ChatCompletionMessageParam
} from "openai/resources/index.mjs";
import { client, grabJson, messageReducer, model } from "./llm.js";
import { recordThought, suggestions, updateThought } from "./model.js";
import { examples } from "./implement.js";
import { describeTools, planningToolSpec, toolSpec } from "./tools.js";
import { LLMClient } from "@commontools/llm-client";
import { LLM_SERVER_URL } from "../llm-client.js";
import { appGraph } from "../components/com-app.js";
import { Graph } from "../reactivity/runtime.js";
import { Recipe } from "../data.js";

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
    system: `${examples} ${steps[0]}`
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

export function sketchReactVersion(userRequests: string[]) {
  const system = `Generate a dead simple react application using typescript and JSX all in one file. Do not worry about the overall application structure, just generate a unified solution to the problem.

  Include no styles on the components. When the user asks for a side effect or rendering output you cannot provide, use \`placeholder(description: string)\`. For a UI component that use \`<Placeholder description="" />\` for similar effect.

  Include brief clarifying comments for intended behaviour, data flow and possible future extension.`;

  return {
    system,
    prompt: `${userRequests.map((req) => `<user-request>${req}</user-request>`).join("\n")}`
  };
}

export function transformToGraph(reactVersion: string) {
  return {
    system: documentation(
      "Convert a simple application description to a reactive graph programming paradigm.",
      ""
    ),
    prompt: reactVersion
  };
}

export function fixGraph(code: string, spec: string, errors: string[]) {
  return {
    system: documentation("Fix the errors in the provided implementation.", ""),
    prompt: `<spec>${spec}</spec>\n<code>${code}</code>\n<errors>${errors.map((e) => `<error>${e}</error>`).join("\n")}</errors>`
  };
}

export function documentation(prefix: string, suffix: string) {
  const system = `${prefix}

  type Id = string
  type PortName = string

  type Bindings = {
    inputs: [PortName], // named arguments for this node
    outputs: { [target: Id]: PortName } // bindings for the output of this node
  }

  ---

  addState(id: Id, explanation: string, initial: any, bindings: Bindings)

  state nodes can only be mutated when the output of another node is bound to any input port and updated

  ---

  addTransformation(id: Id, explanation: string, code: string, bindings: Bindings)

  transformation nodes are designed to format data before displaying it, persisting it or handing it to another process

  their bindings are arguments and the function runs whenever one changes, producing a new output, they are always pure.

  <examples>
    <example>
      addState(
        "myValue",
        "Example value for transformations",
        0,
        {
          "inputs": [],
          "outputs": {
            "multiplyByTwo": "value"
          }
        }
      )

      addTransformation(
        "multiplyByTwo",
        "Double the value of a number.",
        "function (value) {
          return value * 2;
        }",
        {
          "inputs": ["value"],
          "outputs": {}
        }
      )
    </example>

    <example>
    addTransformation(
      "filterCheckedTodos",
      "Filter todos to only show checked todos.",
      "function (todos) {
        return todos.filter(todo => todo.checked);
      }",
      {
        "inputs": ["todos"],
        "outputs": {
          "todoListUi": "filteredTodos"
        }
      }
    )
    </example>
  </examples>

  ---

  addUi(id: Id, explanation: string, template: string, bindings: Bindings)

  UI nodes show a view for a user to interact with, they can dispatch events by name which will be bound to by handlers.

  <examples>
    <example>
    addUi(
      "imageUi",
      "A simple image gallery showing images in a list.",
      {
        "tag": "ul",
        "props": {
          "className": "image"
        },
        "children": {
          "type": "repeat",
          "binding": "images",
          "template": {
            "tag": "li",
            "props": {},
            "children": [
              {
                "tag": "img",
                "props": {
                  "src": { "@type": 'binding', "name": 'src' },
                },
                "children": []
              }
            ],
          }
        }
      },
      {
        "inputs": ["images"],
        "outputs": { }
      }
    )
    </example>
    <example>
    addUi(
      "basicDataUi",
      "A simple value displayed as text.",
      {
        "tag": "span",
        "props": { "innerText": { "@type": "binding", "name": "text" } },
        "children": [ ]
      },
      {
        "inputs": ["text"],
        "outputs": { }
      }
    )
    </example>
    <example>
    addUi(
      "todoUi",
      "A todo list with checkboxes.",
      {
        "tag": "ul",
        "props": {
          "className": "todo"
        },
        "children": [
          {
            "@type": "repeat",
            "name": "todos",
            "template": {
              "tag": "li",
              "props": {},
              "children": [
                {
                  "tag": "input",
                  "props": {
                    "type": "checkbox",
                    "checked": { "@type": "binding", "name": "checked" }
                  },
                  "children": []
                },
                {
                  "tag": "span",
                  "props": {
                    "className": "todo-label",
                    "innerText": { "@type": "binding", "name": "label" }
                  },
                  "children": [ ]
                }
              ]
            }
          }
        ]
      },
      {
        "inputs": ["todos"],
        "outputs": {
      }
    )
    </example>
  </examples>

  ---

  addEventListener(id: Id, explanation: string, event: string, code: string, bindings: Bindings)

  event listeners cannot access any other functions in the namespace, they must react directly to user input and mutate state. bind to an event from the UI and bind the output to a state node (or another function for further transformation)

  they will not be triggered when their input bindings change, only when their event is fired

  <examples>

  <example>
  addUi({
    "id": "generateRandom",
    "explanation": "A button that generates a random number",
    "template": {
      "tag": "button",
      "props": {
        "@click": { "@type": "binding", "name": "clicked" }
      },
      "children": [ "Click me" ]
    },
    "bindings": {
      "inputs": [],
      "outputs": {}
    }
  })

  addEventListener({
    "id": "onGenerateRandom",
    "event": "clicked",
    "code": "return Math.random()"
  })
  </example>

  <example>
  addState({
    "id": "counter",
    "explanation": "A counter.",
    "initial": 0,
    "bindings": {
      "inputs": [],
      "outputs": {
        "incrementButton": "counter"
      }
    }
  })

  addUi({
    "id": "incrementButton",
    "explanation": "A button that increments the counter",
    "template": {
      "tag": "button",
      "props": {
        "@click": { "@type": "binding", "name": "clicked" },
        "innerText": { "@type": "binding", "name": "counter" }
      },
      "children": [
        "Click me"
      ]
    },
    "bindings": {
      "inputs": ["counter"],
      "outputs": {}
    }
  })

  addEventListener({
    "id": "onIncrement",
    "event": "clicked",
    "code": "function (counter) {
      return counter + 1
    },
    "bindings": {
      "inputs": ["counter"],
      "outputs": {
        "counter": "counter"
      }
    }
  })
  </example>

  </examples>

  ---

  think methodically, step by step, avoid creating transformation nodes when event handlers can do the job.

  add clear comments to each node indicating its purpose (do not repeat the information easily grokked from code)

  ---

  ${suffix}

  ---

  Return two blocks, a description of the application in SpecLang (https://githubnext.com/projects/speclang/) format within a markdown block followed by the calls needed to construct the graph.`;

  return system;
}

export function sketchHighLevelApproachPrompt(
  userRequests: string[],
  graph: Recipe
) {
  if (graph.nodes.length == 0) {
    return {
      system: `You are an expert software engineer familiar with functional reactive UI. You are working with a user to create a disposable software application. The environment is a reactive graph computation model. Modules, a.k.a nodes, connect with each other, where the output of one or more nodes serves as the input to another.

      Programs are composed of data, mapping functions, UI and view nodes and event listeners to receive input.

      ${describeTools(planningToolSpec, false)}

      Implementation always looks like: data -> mapping functions -> UI and view nodes -> event listeners -> data. Functions must be pure and self-contained, they cannot reference one another except via connection.

      Your task is to plan how to implement an application based on a user's request. Declare the nodes and give reasoning in the docstring of each as to how it fits into the overall picture.

      Keep the design simple, these are programs that the user should be able to understand.
      Keep the chat to a minimum do all the explaining in the docstring, not in the chat.
        `,
      prompt: `${userRequests.map((req) => `<user-request>${req}</user-request>`).join("\n")}`
    };
  }

  return {
    system: `You are an expert software engineer familiar with functional reactive UI. working with a user to modify a disposable software application. The environment is a reactive graph computation model. Modules, a.k.a nodes, connect with each other, where the output of one or more nodes serves as the input to another.

    Programs are composed of data, mapping functions, UI and view nodes and event listeners to receive input.

    ${describeTools(planningToolSpec, false)}

    Implementation always looks like: data -> mapping functions -> UI and view nodes -> event listeners -> data. Functions must be pure and self-contained, they cannot reference one another except via connection.

    Your task is to plan how to modify an existing application based on a user's request. Modify, declare and delete nodes and give reasoning in the docstring of each as to how it fits into the overall picture. Update the docstring of the existing nodes to reflect the changes.

    <program>
    ${JSON.stringify(graph, null, 2)}
    </program>

    Keep the chat to a minimum do all the explaining in the docstring, not in the chat.
      `,
    prompt: `${userRequests.map((req) => `<user-request>${req}</user-request>`).join("\n")}`
  };
}

export function planIdentifiers(
  step: string,
  userRequests: string[],
  existingPlan: string,
  graphSnapshot: string
) {
  return {
    system: `You will enrich a specification for an ephemeral software application by detailing components needed to implement it.

      The environment is a reactive graph computation model. Modules, a.k.a nodes, connect with each other, where the output of one or more nodes serves as the input to another. Available modules include:

      ${describeTools(toolSpec, false)}

      Each node has one or more inputs and a single output. You will work step by step and enrich a loose plan, so for an example plan:

      <user-request>Counter with button</user-request>

      <plan>
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

      <user-request>Make a sphere</user-request>

      <plan>
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

      ${userRequests.map((request) => `<user-request>${request}</user-request>`).join("\n")}

      The specification may already be partially implemented, see this snapshot of the current state:
      <graph>
        ${graphSnapshot}
      </graph>

      ${
        existingPlan.length > 0
          ? `The user and you have already collaborated on a WIP specification, you should refer to this to inform your enriching, the step may already be correct.
      <plan>${existingPlan}</plan>`
          : ``
      }

      Define all functions as signature stubs, modify the plan to add more detail about the intended implementation as needed.
      Pay extra attention to connecting all parameters to functions and UI nodes. They cannot access data without explicit connections.`,

    prompt: step
  };
}

export function makeConsistent(plan: string, userRequests: string[]) {
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

      <user-request>Make a coin flipper</user-request>
      <user-request>Make the label DO IT!</user-request>

      <plan>
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

      <user-request>Make a coin flipper</user-request>
      <user-request>Make the label DO IT!</user-request>

      <corrected-plan>
        <step>Create a data node to store the coin state (heads or tails)</step>
        <identifier>coinState = "tails"</identifier>
        <step>Add a button UI node labeled "DO IT!"</step>
        <identifier>addButton = button({ label: "DOI IT!", "@click": "clicked" })</identifier>
        <step>Create an event listener for the button click and update the coin state</step>
        <identifier>flipCoin = on("clicked", () => Math.random() < 0.5 ? 'heads' : 'tails')</identifier>
        <connection>flipCoin -> coinState</connection>
        <step>Display the current coin state with a text UI node</step>
        <identifier>text(coinState)</identifier>
        <connection>coinState -> text.coinState</connection>
      </corrected-plan>

      Avoid fully specifying function bodies, but feel free sketch the implementation or leave a clarifying comment for later.
      Do not significantly rework the entire document, do not introduce new features.
      Be clear but concise, using technical terms. Every word is a wasted moment for the user but they must understand your reasoning.

      Take extra care not to bloat the request beyond the original scope, implement the MVP that satisfies the user request.

      ${userRequests.map((request) => `<user-request>${request}</user-request>`).join("\n")}
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
