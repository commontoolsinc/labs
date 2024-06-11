import { LitElement, html } from "lit-element";
import { customElement, state } from "lit/decorators.js";
import { base } from "../styles.js";

import { Recipe, emptyGraph, todoAppMockup, RecipeNode } from "../data";
import { doLLM, grabJson, processUserInput } from "../llm";
import { collectSymbols } from "../graph";
import { Context, snapshot } from "../state";
import { watch } from "@commontools/common-frp-lit";
import { SignalSubject } from "../../../common-frp/lib/signal.js";
import { plan, prepareSteps } from "../plan.js";
import { thoughtLog } from "../model.js";

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

@customElement("com-app")
export class ComApp extends LitElement {
  static styles = [base];

  static properties = {
    graph: { type: Object },
    userInput: { type: String },
    snapshot: { type: Object }
  };

  @state() graph: Recipe = emptyGraph;
  @state() userInput = "";
  @state() snapshot: Context<SignalSubject<any>>;

  async appendMessage() {
    const newGraph = [...this.graph];
    const spec = await plan(this.userInput, prepareSteps(this.userInput));
    const finalPlan = spec?.[spec?.length - 1];
    console.log("finalPlan", finalPlan);
    const input = `Implement the following plan using the available tools: ${finalPlan?.content} --- Current graph: \`\`\`json${JSON.stringify(this.graph)}\`\`\``;

    const symbols = collectSymbols(this.graph);
    symbols.reverse();

    this.graph = newGraph;
    this.userInput = "";

    const systemContext = `Prefer to send tool calls in serial rather than in one large block, this way we can show the user the nodes as they are created.`;
    const lastFmKey = "0060ba224307ff9f787deb837f4be376";

    const availableFunctions = {
      listNodes: () => {
        console.log("listNodes", this.graph);
        return JSON.stringify(this.graph);
      },
      addCodeNode: ({ id, node, code }) => {
        console.log("addCodeNode", id, node, code);
        newGraph.push({
          id,
          contentType: "text/javascript",
          in: {},
          ...node,
          body: code
        });
        this.graph = JSON.parse(JSON.stringify(newGraph));
        this.requestUpdate();
        return `Added node: ${id}`;
      },
      addUiNode: ({ id, node, body }) => {
        console.log("addUiNode", id, node, body);
        newGraph.push({
          id,
          contentType: "application/json+vnd.common.ui",
          in: {},
          ...node,
          body
        });
        this.graph = JSON.parse(JSON.stringify(newGraph));
        this.requestUpdate();
        return `Added node: ${id}`;
      },
      addFetchNode: ({ id, url }) => {
        console.log("addFetchNode", id, url);
        newGraph.push({
          id,
          contentType: "application/json+vnd.common.fetch",
          in: {},
          outputType: {
            type: "object"
          },
          body: url
        });
        this.graph = JSON.parse(JSON.stringify(newGraph));
        this.requestUpdate();
        return `Added node: ${id}`;
      },
      addLanguageModelNode: ({ id, promptSource }) => {
        console.log("addLanguageModelNode", id, prompt);
        newGraph.push({
          id,
          contentType: "application/json+vnd.common.llm",
          in: {
            prompt: [".", promptSource]
          },
          outputType: {
            type: "string"
          },
          body: ""
        });
        this.graph = JSON.parse(JSON.stringify(newGraph));
        this.requestUpdate();
        return `Added node: ${id}`;
      },
      addImageGenerationNode: ({ id, promptSource }) => {
        console.log("addImageGenerationNode", id, prompt);
        newGraph.push({
          id,
          contentType: "application/json+vnd.common.image",
          in: {
            prompt: [".", promptSource]
          },
          outputType: {
            type: "string"
          },
          body: ""
        });
        this.graph = JSON.parse(JSON.stringify(newGraph));
        this.requestUpdate();
        return `Added node: ${id}`;
      },
      addMusicSearchNode: ({ id, query }) => {
        console.log("addMusicSearchNode", id, query);
        newGraph.push({
          id,
          contentType: "application/json+vnd.common.fetch",
          in: {},
          outputType: {
            type: "object",
            properties: {
              results: {
                type: "object",
                properties: {
                  albummatches: {
                    type: "object",
                    properties: {
                      albums: {
                        type: "array",
                        items: {
                          type: "object"
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          body: `https://ws.audioscrobbler.com/2.0/?method=album.search&album=${query}&api_key=${lastFmKey}&format=json`
        });
        this.graph = JSON.parse(JSON.stringify(newGraph));
        this.requestUpdate();
        return `Added node: ${id}`;
      },
      replaceNode: ({ id, node, body }) => {
        console.log("replaceNode", id, node, body);
        const index = newGraph.findIndex((n) => n.id === id);
        newGraph[index] = {
          id,
          contentType: "application/json+vnd.common.ui",
          in: {},
          ...node,
          body
        };
        this.graph = JSON.parse(JSON.stringify(newGraph));
        this.requestUpdate();
        return `Replaced node: ${id}`;
      },
      deleteNode: ({ id }) => {
        console.log("deleteNode", id);
        const index = newGraph.findIndex((n) => n.id === id);
        newGraph.splice(index, 1);
        this.graph = JSON.parse(JSON.stringify(newGraph));
        this.requestUpdate();
        return `Deleted node: ${id}`;
      },
      getNodeOutputValue: ({ id }) => {
        const val = this.snapshot.outputs?.[id];
        console.log("getNodeOutputValue", id, val);
        return JSON.stringify(val);
      }
    };
    const result = await processUserInput(
      input,
      codePrompt + systemContext,
      availableFunctions
    );
    console.log("result", result);

    this.graph = JSON.parse(JSON.stringify(newGraph));
    console.log("graph updated", this.graph);
  }

  render() {
    const setUserInput = (input: string) => {
      this.userInput = input;
    };

    const setContext = (context: Context) => {
      this.snapshot = snapshot(context);
      console.log("SNAPSHOT", this.snapshot);
    };

    return html`
      <com-app-grid>
        <com-chat slot="main">
          <com-thread
            slot="main"
            .graph=${this.graph}
            .setContext=${setContext}
          ></com-thread>
          <div slot="footer">
            <com-unibox>
              <com-editor
                slot="main"
                .value=${this.userInput}
                .setValue=${setUserInput}
              ></com-editor>
              <com-button slot="end" .action=${() => this.appendMessage()}
                >Send</com-button
              >
            </com-unibox>
          </div>
        </com-chat>
        <div slot="sidebar">
          <com-thought-log .thoughts=${watch(thoughtLog)}></com-thought-log>
        </div>
      </com-app-grid>
    `;
  }
}
