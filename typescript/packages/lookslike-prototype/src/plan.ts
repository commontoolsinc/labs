import {
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionTool
} from "openai/resources/index.mjs";
import { client, messageReducer, model, toolSpec } from "./llm.js";
import { recordThought, updateThought } from "./model.js";

export const codePrompt = `
  Your task is to take a user description or request and produce a series of nodes for a computation graph. Nodes can be code blocks or UI components and they communicate with named ports.

  You will construct the graph using the available tools to add, remove, replace and list nodes.
  You will provide the required edges to connect data from the environment to the inputs of the node. The keys of \`in\` are the names of local inputs and the values are NodePaths (of the form [context, nodeId], where context is typically '.' meaning local namespace).

  "Imagine some todos" ->

  addCodeNode({
    "id": "todos",
    "node": {
      "in": {},
      "outputType": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "label": { "type": "string" },
            "checked": { "type": "boolean" }
          }
        }
      },
    },
    "code": "return [{ label: 'Water my plants', checked: false }, { label: 'Buy milk', checked: true }];"
  })

  Tasks that take no inputs require no edges.
  All function bodies must take zero parameters. Inputs can be accessed via 'read' and 'deref'.

  ---

  "Remind me to water the plants" ->

  addCodeNode({
    "id": "addReminder",
    "node": {
      "in": {},
      "outputType": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "label": { "type": "string" },
            "checked": { "type": "boolean" }
          }
        }
      },
    },
    "code": "const todos = input('todos');\nconst newTodo = { label: 'water the plants', checked: false };\nconst newTodos = [...todos, newTodo];\nreturn newTodos;"
  })

  Tasks that take no inputs require no edges.

  ---


  "Take the existing todos and filter to unchecked" ->

  addCodeNode({
    "id": "filteredTodos",
    "node": {
      "in": {
        "todos": [".", "todos"]
      },
      "outputType": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "label": { "type": "string" },
            "checked": { "type": "boolean" }
          }
        }
      },
    },
    "code": "const todos = input('todos');\nreturn todos.filter(todo => todo.checked);"
  })

  Tasks that filter other data must pipe the data through the edges.
  All function bodies must take zero parameters. Inputs can be accessed via 'input()', values may be null.
  Always respond with code, even for static data. Wrap your response in a json block. Respond with nothing else.

  ---

  "render each image by url" ->
  images is an array of strings (URLs)

  addUiNode({
    "id": "imageUi",
    "node": {
      "in": {
        "images": [".", "images"]
      },
      "outputType": {
        "$id": "https://common.tools/ui.schema.json"
      },
    },
    "body": {
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

  addUiNode({
    "id": "todoUi",
    "node": {
      "in": {
        "todos": [".", "todos"]
      },
      "outputType": {
        "$id": "https://common.tools/ui.schema.json"
      },
    },
    "body": {
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
  if (steps.length === 0) {
    console.warn("No steps in plan");
    return;
  }

  console.log(`[${userInput}] plan`, steps);

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
    console.log(`[${userInput}] response`, latest);
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

  return messages;
}

export async function suggest(input: string, fullPlan: Conversation) {
  const response = await client.chat.completions.create({
    messages: [
      ...fullPlan,
      {
        role: "user",
        content: `Based on the original user request (${input}) and the plan to service it, suggest 3 similar or related tasks the user might like to explore next. This could include tweaks to the existing UI, reusing the data in another context or a mix of both. Be concise, use a numbered list with no more than 7 words per item.`
      }
    ],
    model,
    temperature: 0
  });

  recordThought(response.choices[0].message);

  return response.choices[0].message;
}

export function describeTools(tools: ChatCompletionTool[]) {
  return tools
    .map((tool) => {
      return `- ${tool.function.name}: ${tool.function.description}`;
    })
    .join("\n");
}

export function prepareSteps(userInput: string) {
  return [
    `Assist a user in dynamically generating software to solve their problems using a reactive graph data model. Modules, acting as nodes, connect with each other, where the output of one or more nodes serves as the input to another. Available modules:

    ${describeTools(toolSpec)}

    To declare a constant value, return it from a code node as a literal.

    Be extremely concise, using code or pseudocode as needed. Do not worry about the plan being human readable.`,
    `
    <user-request>${userInput}</user-request>

    Based on the request and available modules, list requirements for a simple piece of ephemeral software:
    - Retrieve, map, filter and render using a reactive graph data model
    - Connect modules with output/input relationships`,
    `At a high level, plan which nodes and connections you will create in the reactive graph to service an MVP version of this request.
      Give each node an ID and describe its purpose. Each node can have several named inputs which can be mapped to the outputs of other node ID.
      The output of all nodes must be used and all inputs must be mapped to valid outputs.
    `,
    `Reflect on the plan, does it make sense for a incredibly small immediately useful application?

    Ensure all node are created in a logical order, so that the dependencies always exist. Start with fetching data, then processing, filtering, mapping and rendering.
    You must create a code node to declare any constant values. Do this before anything else.

    Adjust the plan to make sure the user will be happy with the request: ${userInput}`
    // `With the requirements specified, create a user interface using the following UI components:

    // - **Input box (\`input\`)**: Collect basic user input (text, number).
    // - **Data table (\`data\`)**: Display sortable and filterable rows of records with optional actions.
    // - **List (\`list\`)**: Display a list of items with optional actions.
    // - **Calendar (\`calendar\`)**: Show a calendar with items on each day.
    // - **Detail card (\`card\`)**: Show an information card for a document/item with appropriate data rendering.
    // - **Card pile (\`pile\`)**: Display a z-stacked set of media items with optional actions.
    // - **Text/code/data editor (\`editor\`)**: Provide a basic editor for unformatted text.

    // For the MVP, use the most appropriate components to present the interface:

    // 1. **Input Box**: Collect user input.
    // 2. **Data Table**: Display and manage records.
    // 3. **Detail Card**: Show detailed information for selected items.

    // Keep the interface simple to gradually build towards a complete application.`
  ];
}
