import { LitElement, html } from 'lit-element'
import { customElement, state } from 'lit/decorators.js'
import { base } from '../styles'

import { Recipe, emptyGraph, todoAppMockup, RecipeNode } from '../data'
import { doLLM, grabJson } from '../llm'
import { collectSymbols } from '../graph'
import { listKeys } from '../state'

const codePrompt = `
  Your task is to take a user description or request and produce a series of nodes for a computation graph. Nodes can be code blocks or UI components and they communicate with named ports.
  you will provide the required edges to connect data from the environment to the inputs of the node. The keys of \`in\` are the names of local inputs and the values are NodePaths (of the form [context, nodeId], where context is typically '.' meaning local namespace).

  "Imagine some todos" ->

  \`\`\`json
  [
    {
      "id": "todos",
      "contentType": "text/javascript",
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
      "body": "return [{ label: 'Water my plants', checked: false }, { label: 'Buy milk', checked: true }];"
    }
  ]
  \`\`\`

  Tasks that take no inputs require no edges.
  All function bodies must take zero parameters. Inputs can be accessed via 'read' and 'deref'.

  ---

  "Remind me to water the plants" ->

  \`\`\`json
  [
    {
      "id": "addReminder",
      "contentType": "text/javascript",
      "in": {},
      "outputType": {},
      "body": "const todos = input('todos'); const newTodo = { label: 'water the plants', checked: false }; cost newTodos = [...todos, newTodo]; return newTodos;"
    }
  ]
  \`\`\`

  Tasks that take no inputs require no edges.

  ---

  "Take the existing todos and filter to unchecked" ->
  \`\`\`json
  [
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
      "body": "const todos = input('todos'); return todos.filter(todo => todo.checked);"
    }
  ]
  \`\`\`

  Tasks that filter other data must pipe the data through the edges.
  All function bodies must take zero parameters. Inputs can be accessed via 'input()', values may be null.

  ContentType should be "text/javascript" for code.
  Always respond with code, even for static data. Wrap your response in a json block. Respond with nothing else.

  ---

  "render each image by url" ->
  images is an array of strings (URLs)

  \`\`\`json
  [
    {
      "id": "imageUi",
      "contentType": "application/json+vnd.common.ui",
      "in": {
        "images": [".", "images"]
      },
      "outputType": {
        "$id": "https://common.tools/ui.schema.json"
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
    }
  ]

  Raw values can be passed through by setting binding to null.

  ---

  "render my todos" ->

  \`\`\`json
  [
    {
      "id": "todoUi",
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
  ]
  \`\`\`

  ContentType should be "application/json+vnd.common.ui" for UI. UI trees cannot use any javascript methods, code blocks must prepare the data for the UI to consume.

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

    const symbols = collectSymbols(this.graph);
    symbols.reverse();

    this.graph = newGraph;
    this.userInput = '';

    const localContext = `
      The following nodes are available in the current context, these can be referenced by name when wiring the graph.

      \`\`\`json
      ${JSON.stringify(symbols, null, 2)}
      \`\`\`

      The keys at the top of the list are the most recently created by the user, prefer these when making connections.
      Ensure the you use the name you assign to the input in the body of the code for any read calls.
      `

    const systemContext = ``

    const result = await doLLM(input + localContext, codePrompt + systemContext, null)
    const message = result?.choices[0]?.message
    if (message) {
      const data = grabJson(message?.content)
      for (const node of data) {
        node.messages = []
        newGraph.push(node)
      }

      // newNode.id = data.id || id
      // newNode.contentType = data.contentType || 'text/javascript'
      // newNode.outputType = data.outputType || {}
      // newNode.body = data.body || '...'
      // newNode.in = data.in || {}
      // newNode.messages = data.messages || newNode.messages
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
