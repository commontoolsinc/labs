import { LitElement, html } from 'lit-element'
import { customElement, state } from 'lit/decorators.js'
import { base } from '../styles'

import { Recipe, emptyGraph, todoAppMockup, RecipeNode } from '../data'
import { doLLM, grabJson } from '../llm'

const codePrompt = `
  Your task is to take a user description or request and produce a node definition of a computation graph, for example:

  Also provide the required edges to connect data from the environment to the inputs of the node. The keys of \`in\` are the names of local inputs and the values are NodePaths (of the form [context, nodeId], where context is typically '.' meaning local namespace).

  "Fetch my todos" ->

  \`\`\`json
  {
    "id": "todos",
    "messages": [
      {
        "role": "user",
        "content": "get my todos"
      },
      {
        "role": "assistant",
        "content": "..."
      }
    ],
    "contentType": "text/javascript",
    "in": {},
    "outputType": {
      "$id": "https://common.tools/stream.schema.json",
      "type": {
        "$id": "https://common.tools/todos.json"
      }
    },
    "body": "return system.get('todos')"
  },
  \`\`\`

  Tasks that take no inputs require no edges.

  "Take the existing todos and filter to unchecked" ->
  \`\`\`json
  {
    "id": "filteredTodos",
    "contentType": "text/javascript",
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
    "body": "return inputs.todos.filter(todo => todo.checked)"
  }
  \`\`\`

  Tasks that filter other data must pipe the data through the edges.

  Wrap your response in a json block. Respond with nothing else.
  notalk;justgo
`

const uiPrompt = `
  Your task is to take a user description or request and produce a UI node definition for the rendering of a data in a computation graph, for example:

  Also provide the required edges to connect data from the environment to the inputs of the node. The keys of \`in\` are the names of local inputs and the values are NodePaths (of the form [context, nodeId], where context is typically '.' meaning local namespace).

  "render my todos" ->

  \`\`\`json
  {
    "id": "todoUi",
    "messages": [
      {
        "role": "user",
        "content": "render todo"
      },
      {
        "role": "assistant",
        "content": "..."
      }
    ],
    "contentType": "application/json+vnd.common.ui",
    "in": {
      "todos": [".", "todos"]
    },
    "outputType": {
      "$id": "https://common.tools/ui.schema.json"
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
  }
  \`\`\`

  Wrap your response in a json block. Respond with nothing else.
  notalk;justgo
`

@customElement('com-app')
export class ComApp extends LitElement {
  static styles = [base]

  @state() graph: Recipe = emptyGraph
  @state() userInput = ''

  async appendMessage() {
    const newGraph = [...this.graph]
    // TODO: let GPT name the node
    const id = 'new' + (Math.floor(Math.random() * 1000))
    const input = `${this.userInput}`

    const newNode: RecipeNode = {
      id,
      messages: [
        {
          role: 'user',
          content: input
        }
      ],
      // TODO: generate these
      in: {},
      outputType: {},
      contentType: 'text/javascript',
      body: ''
    }

    newGraph.push(newNode);
    this.graph = newGraph;
    this.userInput = '';

    const systemPrompt = input.includes('render') ? uiPrompt : codePrompt
    const result = await doLLM(input, systemPrompt, null)
    const message = result?.choices[0]?.message
    if (message) {
      const data = grabJson(message?.content)
      newNode.id = data.id || id
      newNode.contentType = data.contentType || 'text/javascript'
      newNode.outputType = data.outputType || {}
      newNode.body = data.body || '...'
      newNode.in = data.in || {}
      newNode.messages = data.messages || newNode.messages
    }

    this.graph = JSON.parse(JSON.stringify(newGraph));
    console.log('graph updated', this.graph);
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
