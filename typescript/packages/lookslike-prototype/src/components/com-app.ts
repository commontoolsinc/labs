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

  "Fetch my todos" ->

  \`\`\`json
  [
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
      "body": "function() { return read('todos'); }"
    }
  ]
  \`\`\`

  Tasks that take no inputs require no edges.

  ---

  "Remind me to water the plants" ->

  \`\`\`json
  [
    {
      "id": "addReminder",
      "contentType": "text/javascript",
      "in": {},
      "outputType": {},
      "body": "async function() { const todos = await system.get('todos'); const newTodo = { label: 'water the plants', checked: false }; await system.set('todos', [...todos, newTodo]); return newTodo; }"
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
      "body": "function() { return inputs.todos.filter(todo => todo.checked); }"
    }
  ]
  \`\`\`

  Tasks that filter other data must pipe the data through the edges.

  ContentType should be "text/javascript" for code.
  Always respond with code, even for static data. Wrap your response in a json block. Respond with nothing else.

  render my todos" ->

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

      The keys at the top of the list are the most recently created by the user, prefer these.
      `

    const systemContext = `
      The current keys available in the system DB are:

      \`\`\`json
      ${JSON.stringify((await listKeys()).map(k => `system.get('${k}')`), null, 2)}
      \`\`\`
    `

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
