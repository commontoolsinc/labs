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
