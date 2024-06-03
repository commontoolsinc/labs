import { LitElement, html } from 'lit-element'
import { customElement, state } from 'lit/decorators.js'
import { base } from '../styles'

import { Graph, GraphNode, emptyGraph, todoAppMockup } from '../data'
import { doLLM, grabJson } from '../llm'

const codePrompt = `
  Your task is to take a user description or request and produce a node definition of a computation graph, for example:

  Also provide the required edges to connect data from the environment to the inputs of the node. The keys of the \`edges\` are the names of local inputs and the values are variables available in the broader scope.

  "Fetch my todos" ->

  \`\`\`json
  {
    "definition": {
      "name": "todos",
      "contentType": "text/javascript",
      "signature": {
        "inputs": {},
        "output": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "label": { "type": "string" },
              "checked": { "type": "boolean" }
            }
          }
        }
      },
      "body": "return system.get('todos')"
    },
    "edges": {}
  }
  \`\`\`

  Tasks that take no inputs require no edges.

  "Take the existing todos and filter to unchecked" ->
  \`\`\`json
  {
    "definition": {
      "name": "filteredTodos",
      "contentType": "text/javascript",
      "signature": {
        "inputs": {
          "todos": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "label": { "type": "string" },
                "checked": { "type": "boolean" }
              }
            }
          }
        },
        "output": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "label": { "type": "string" },
              "checked": { "type": "boolean" }
            }
          }
        }
      },
      "body": "return inputs.todos.filter(todo => todo.checked)"
    },
    "edges": {
      // all keys must correspond to the inputs
      "todos": "tasks"
    }
  }
  \`\`\`

  Tasks that filter other data must pipe the data through the edges.

  Wrap your response in a json block. Respond with nothing else.
  notalk;justgo
`

const uiPrompt = `
  Your task is to take a user description or request and produce a UI node definition for the rendering of a data in a computation graph, for example:

  Also provide the required edges to connect data from the environment to the inputs of the node. The keys of the \`edges\` are the names of local inputs and the values are variables available in the broader scope.

  "render my todos" ->

  \`\`\`json
  {
    "definition": {
      "name": "todoUi",
      "contentType": "application/json+vnd.common.ui",
      "signature": {
        "inputs": {
          "todos": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "label": { "type": "string" },
                "checked": { "type": "boolean" }
              }
            }
          }
        },
        "output": {
          "type": "object"
        }
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
    },
    "edges": {
      "todos": "todos"
    }
  }
  \`\`\`

  Wrap your response in a json block. Respond with nothing else.
  notalk;justgo
`

@customElement('com-app')
export class ComApp extends LitElement {
  static styles = [base]

  @state() graph: Graph = emptyGraph
  @state() userInput = ''

  async appendMessage() {
    const newGraph = { ...this.graph }
    const id = 'new' + (Math.floor(Math.random() * 1000))
    const input = `${this.userInput}`

    const newNode: GraphNode = {
      id,
      messages: [
        {
          role: 'user',
          content: input
        }
      ]
    }

    newGraph.nodes.push(newNode);
    newGraph.order.push(id);
    this.graph = newGraph;
    this.userInput = '';

    const systemPrompt = input.includes('render') ? uiPrompt : codePrompt
    const result = await doLLM(input, systemPrompt, null)
    const message = result?.choices[0]?.message
    if (message) {
      const data = grabJson(message?.content)
      const definition = data?.definition
      if (data && definition) {
        newNode.definition = definition;

        // add all new edges
        for (const [key, value] of Object.entries(data.edges || {})) {
          newGraph.edges.push({
            [key]: [definition.name, (value as string).replace('./', '')]
          })
        }

        console.log(newGraph)
      } else {
        newNode.messages.push(message);
      }
    }

    this.graph = JSON.parse(JSON.stringify(newGraph));
  }

  render() {
    const setUserInput = (input: string) => {
      this.userInput = input
    }

    return html`
      <com-app-grid>
        <com-chat slot="main">
            <com-thread slot="main" .graph=${this.graph}></com-thread>
            <div slot="footer">
                <com-unibox>
                    <com-editor slot="main" .value=${this.userInput} .setValue=${setUserInput}></com-editor>
                    <com-button slot="end" .action=${() => this.appendMessage()}>Send</com-button>
                </com-unibox>
            </div>
        </com-chat>
        <div slot="sidebar">

        </div>
    </com-app-grid>
    `
  }
}
