import { LitElement, html } from 'lit-element'
import { customElement, state } from 'lit/decorators.js'
import { base } from '../styles'

import { Recipe, emptyGraph, todoAppMockup, RecipeNode } from '../data'
import { doLLM, grabJson, processUserInput } from '../llm'
import { collectSymbols } from '../graph'
import { listKeys } from '../state'

const codePrompt = `
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
    "code": \`
      return [{ label: 'Water my plants', checked: false }, { label: 'Buy milk', checked: true }];
    \`
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
    "code": \`
      const todos = input('todos');
      const newTodo = { label: 'water the plants', checked: false };
      const newTodos = [...todos, newTodo];
      return newTodos;
    \`
    }
  )

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
    "code": \`
      const todos = input('todos');
      return todos.filter(todo => todo.checked);
    \`
    }
  )

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

    const systemContext = `
      Ensure you list the current state of the graph and make a detailed step-by-step plan for updating the graph to match the user's request.'

      Prefer to send tool calls in serial rather than in one large block, this way we can show the user the nodes as they are created.
    `

    const availableFunctions = {
      listNodes: () => {
        console.log('listNodes', this.graph)
        return JSON.stringify(this.graph)
      },
      addCodeNode: ({ id, node, code }) => {
        console.log('addCodeNode', id, node, code)
        newGraph.push({ id, contentType: 'text/javascript', ...node, body: code })
        this.graph = JSON.parse(JSON.stringify(newGraph));
        this.requestUpdate();
        return `Added node: ${id}`
      },
      addUiNode: ({ id, node, body }) => {
        console.log('addUiNode', id, node, body)
        newGraph.push({ id, contentType: 'application/json+vnd.common.ui', ...node, body })
        this.graph = JSON.parse(JSON.stringify(newGraph));
        this.requestUpdate();
        return `Added node: ${id}`
      },
      replaceNode: () => 'hello replace',
      deleteNode: () => 'hello delete'
    };
    const result = await processUserInput(input, codePrompt + systemContext, availableFunctions);
    console.log('result', result);

    // const result = await doLLM(input + localContext, codePrompt + systemContext, null)
    // const message = result?.choices[0]?.message
    // if (message) {
    //   const data = grabJson(message?.content)
    //   for (const node of data) {
    //     node.messages = []
    //     newGraph.push(node)
    //   }
    // }

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
