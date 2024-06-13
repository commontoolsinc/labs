import {
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionTool
} from "openai/resources/index.mjs";
import { client, grabJson, messageReducer, model, toolSpec } from "./llm.js";
import { recordThought, suggestions, updateThought } from "./model.js";
import { Recipe } from "./data.js";

export const codePrompt = `
  Your task is to take a user description or request and produce a series of nodes for a computation graph. Nodes can be code blocks or UI components and they communicate with named ports.

  You will construct the graph using the available tools to add, remove, replace and list nodes.
  You will provide the required edges to connect data from the environment to the inputs of the node. The keys of \`in\` are the names of local inputs and the values are NodePaths (of the form [context, nodeId], where context is typically '.' meaning local namespace).

  "Imagine some todos" ->

  addCodeNode({
    "id": "todos",
    "code": "return [{ label: 'Water my plants', checked: false }, { label: 'Buy milk', checked: true }];"
  })

  Tasks that take no inputs require no edges.
  All function bodies must take zero parameters. Inputs can be accessed via 'read' and 'deref'.

  ---

  "Remind me to water the plants" ->

  addCodeNode({
    "id": "addReminder",
    "code": "const todos = input('todos');\nconst newTodo = { label: 'water the plants', checked: false };\nconst newTodos = [...todos, newTodo];\nreturn newTodos;"
  })

  Tasks that take no inputs require no edges.

  ---


  "Take the existing todos and filter to unchecked" ->

  addCodeNode({
    "id": "filteredTodos",
    "code": "const todos = input('todos');\nreturn todos.filter(todo => todo.checked);"
  })

  Tasks that filter other data must pipe the data through the edges.
  All function bodies must take zero parameters. Inputs can be accessed via 'input()', values may be null.
  Always respond with code, even for static data. Wrap your response in a json block. Respond with nothing else.

  ---

  "render each image by url" ->
  The output of a code node will be bound to the input named 'images'

  addUiNode({
    "id": "imageUi",
    "uiTree": {
      "tag": "ul",
      "props": {
        "className": "image"
      },
      "children": [
        "type": "repeat",
        "binding": "images",
        "template": {
          "tag": "li",
          "props": {},
          "children": [
            {
              "tag": "img",
              "props": {
                "src": { type: 'string', binding: null },
              }
            }
          ],
        }
      ]
    }
  })

  Raw values can be passed through by setting binding to null.

  ---

  "render my todos" ->
  The output of a code node will be bound to the input named 'todos'

  addUiNode({
    "id": "todoUi",
    "uiTree": {
      "tag": "ul",
      "props": {
        "className": "todo"
      },
      "children": {
        "type": "repeat",
        "binding": "todos",
        "template": {
          "tag": "li",
          "props": {},
          "children": [
            {
              "tag": "input",
              "props": {
                "type": "checkbox",
                "checked": { type: 'boolean', binding: 'checked' }
              }
            },
            {
              "tag": "span",
              "props": {
                "className": "todo-label"
              },
              "children": [
                { type: 'string', binding: 'label' }
              ]
            }
          ]
        }
      }
    }
  })

  UI trees cannot use any javascript methods, code blocks must prepare the data for the UI to consume.
  notalk;justgo
`;

type Conversation = ChatCompletionMessageParam[];

export async function plan(userInput: string, steps: string[]) {
  const logId = `plan[${userInput}]`;
  console.group(logId);

  if (steps.length === 0) {
    console.warn("No steps in plan");
    return;
  }

  console.log(steps);

  let messages: ChatCompletionMessageParam[] = [
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

export function describeTools(
  tools: ChatCompletionTool[],
  includeParameters: boolean = false
) {
  return tools
    .map((tool) => {
      const description = `- ${tool.function.name}: ${tool.function.description}`;
      const properties = Object.entries(
        tool.function.parameters?.properties || {}
      )
        .map(([name, { type, description }]) => {
          return `  - ${name} (${type}): ${description}`;
        })
        .join("\n");
      if (!includeParameters) {
        return description;
      }
      return `${description}\n${properties}`;
    })
    .join("\n");
}

export function prepareSteps(userInput: string, recipe: Recipe) {
  if (recipe.length === 0) {
    return [
      `You will create and modify software to solve a user's problems using a reactive graph computation model. Modules, a.k.a nodes, connect with each other, where the output of one or more nodes serves as the input to another. Available modules:

      ${describeTools(toolSpec, false)}

      To declare a constant value, return it from a code node as a literal.

      Plan your approach at a high-level dot-point level of detail and be extremely concise using technical terms.`,
      `Service the minimal useful version of this request: <user-request>${userInput}</user-request>.

    Give each node an ID and describe its purpose without writing the full code. Each node can have several named inputs which can be mapped to the outputs of other node ID.
    The output of all nodes must be used and all inputs must be mapped to valid outputs.

    Provide your plan as a list of tool actions you intend to take on the graph.
    `,
      `Reflect on the plan, does it make sense for a incredibly small immediately useful application? Can you implement it with these tools?

      ${describeTools(toolSpec, true)}

    Use pseudocode to sketch the technical approach. Write as concisely and accurately as possible without introducing assumptions or full specifying the details. Code nodes cannot mutate state, they are pure functions only. Do not attempt to model them as having side effects.
    Ensure all node are created in a logical order, so that the dependencies always exist. Start with fetching data, then processing, filtering, mapping and rendering.
    You must create a code node to declare constant values for code but NOT for shader uniforms. For static data you may inline constants into the code/shader nodes.

    Review the plan and make sure the user will be happy with the request: ${userInput}`
    ];
  } else {
    return [
      `Modify a reactive graph based application based on a user request.
      Modules, acting as nodes, connect with each other, where the output of one or more nodes serves as the input to another.

      Available modules:


    ${describeTools(toolSpec, true)}

    The current graph is:

    \`\`\`json
    ${JSON.stringify(recipe, null, 2)}
    \`\`\`

    <user-request>${userInput}</user-request>

    Explain which nodes will be altered, added or removed. Do not repeat the entire graph.
    Code nodes cannot mutate state, they are pure functions only.
    Do not attempt to model them as having side effects`,
      `Reflect on the plan. The user has requested a specific change. Do not overcomplicate it or add superfluous features. Just make the change.

      Recall the request: <user-request>${userInput}</user-request>`
    ];
  }
}
