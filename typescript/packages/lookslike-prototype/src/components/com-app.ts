import { LitElement, html } from "lit-element";
import { customElement, state } from "lit/decorators.js";
import { base } from "../styles.js";

import { Recipe, emptyGraph } from "../data";
import { processUserInput } from "../llm";
import { collectSymbols } from "../graph";
import { Context, snapshot } from "../state";
import { watch } from "@commontools/common-frp-lit";
import { SignalSubject } from "../../../common-frp/lib/signal.js";
import { codePrompt, plan, prepareSteps } from "../plan.js";
import { thoughtLog } from "../model.js";

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
    const userInput = this.userInput;
    this.userInput = "";
    const newGraph = [...this.graph];

    const symbols = collectSymbols(this.graph);
    symbols.reverse();

    const spec = await plan(this.userInput, prepareSteps(userInput));
    const finalPlan = spec?.[spec?.length - 1];
    console.log("finalPlan", finalPlan);
    const input = `Implement the following plan using the available tools: ${finalPlan?.content} --- Current graph: \`\`\`json${JSON.stringify(this.graph)}\`\`\``;

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
      addGlslShaderNode: ({ id, shaderToyCode }) => {
        console.log("addGlslShaderNode", id, shaderToyCode);
        newGraph.push({
          id,
          contentType: "text/glsl",
          in: {},
          body: shaderToyCode
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

    this.graph = newGraph;

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
