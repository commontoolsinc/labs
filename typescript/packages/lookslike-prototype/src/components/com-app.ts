import { LitElement, html } from "lit-element";
import { customElement, state } from "lit/decorators.js";
import { base } from "../styles.js";

import { Recipe, RecipeNode, emptyGraph } from "../data.js";
import { processUserInput } from "../llm.js";
import { collectSymbols } from "../graph.js";
import { Context, snapshot } from "../state.js";
import { watch } from "@commontools/common-frp-lit";
import { SignalSubject } from "../../../common-frp/lib/signal.js";
import { codePrompt, plan, prepareSteps } from "../plan.js";
import { thoughtLog } from "../model.js";

const lastFmKey = "0060ba224307ff9f787deb837f4be376";

@customElement("com-app")
export class ComApp extends LitElement {
  static override styles = [base];

  static override properties = {
    graph: { type: Object },
    userInput: { type: String },
    snapshot: { type: Object }
  };

  @state() graph: Recipe = emptyGraph;
  @state() userInput = "";
  @state() snapshot: Context<SignalSubject<any>> = {
    inputs: {},
    outputs: {},
    cancellation: []
  };

  availableFunctions(graph: Recipe) {
    return {
      listNodes: () => {
        console.log("listNodes", this.graph);
        return JSON.stringify(this.graph);
      },
      addCodeNode: ({
        id,
        node,
        code
      }: {
        id: string;
        node: Partial<RecipeNode>;
        code: string;
      }) => {
        console.log("addCodeNode", id, node, code);
        graph.push({
          id,
          contentType: "text/javascript",
          in: {},
          outputType: {},
          ...node,
          body: code
        });
        this.graph = JSON.parse(JSON.stringify(graph));
        this.requestUpdate();
        return `Added node: ${id}.\n${this.graphSnapshot()}`;
      },
      addUiNode: ({
        id,
        node,
        body
      }: {
        id: string;
        node: Partial<RecipeNode>;
        body: string;
      }) => {
        console.log("addUiNode", id, node, body);
        graph.push({
          id,
          contentType: "application/json+vnd.common.ui",
          in: {},
          outputType: {},
          ...node,
          body
        });
        this.graph = JSON.parse(JSON.stringify(graph));
        this.requestUpdate();
        return `Added node: ${id}.\n${this.graphSnapshot()}`;
      },
      addGlslShaderNode: ({
        id,
        shaderToyCode
      }: {
        id: string;
        shaderToyCode: string;
      }) => {
        console.log("addGlslShaderNode", id, shaderToyCode);
        graph.push({
          id,
          contentType: "text/glsl",
          in: {},
          outputType: {},
          body: shaderToyCode
        });
        this.graph = JSON.parse(JSON.stringify(graph));
        this.requestUpdate();
        return `Added node: ${id}.\n${this.graphSnapshot()}`;
      },
      addFetchNode: ({ id, url }: { id: string; url: string }) => {
        console.log("addFetchNode", id, url);
        graph.push({
          id,
          contentType: "application/json+vnd.common.fetch",
          in: {},
          outputType: {
            type: "object"
          },
          body: url
        });
        this.graph = JSON.parse(JSON.stringify(graph));
        this.requestUpdate();
        return `Added node: ${id}.\n${this.graphSnapshot()}`;
      },
      addLanguageModelNode: ({
        id,
        promptSource
      }: {
        id: string;
        promptSource: string;
      }) => {
        console.log("addLanguageModelNode", id, prompt);
        graph.push({
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
        this.graph = JSON.parse(JSON.stringify(graph));
        this.requestUpdate();
        return `Added node: ${id}.\n${this.graphSnapshot()}`;
      },
      addImageGenerationNode: ({
        id,
        promptSource
      }: {
        id: string;
        promptSource: string;
      }) => {
        console.log("addImageGenerationNode", id, prompt);
        graph.push({
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
        this.graph = JSON.parse(JSON.stringify(graph));
        this.requestUpdate();
        return `Added node: ${id}.\n${this.graphSnapshot()}`;
      },
      addMusicSearchNode: ({ id, query }: { id: string; query: string }) => {
        console.log("addMusicSearchNode", id, query);
        graph.push({
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
        this.graph = JSON.parse(JSON.stringify(graph));
        this.requestUpdate();
        return `Added node: ${id}.\n${this.graphSnapshot()}`;
      },
      replaceNode: ({
        id,
        node,
        body
      }: {
        id: string;
        node: Partial<RecipeNode>;
        body: string;
      }) => {
        console.log("replaceNode", id, node, body);
        const index = graph.findIndex((n) => n.id === id);
        graph[index] = {
          id,
          contentType: "application/json+vnd.common.ui",
          in: {},
          outputType: {},
          ...node,
          body
        };
        this.graph = JSON.parse(JSON.stringify(graph));
        this.requestUpdate();
        return `Replaced node: ${id}.\n${this.graphSnapshot()}`;
      },
      deleteNode: ({ id }: { id: string }) => {
        console.log("deleteNode", id);
        const index = graph.findIndex((n) => n.id === id);
        graph.splice(index, 1);
        this.graph = JSON.parse(JSON.stringify(graph));
        this.requestUpdate();
        return `Deleted node: ${id}.\n${this.graphSnapshot()}`;
      }
    };
  }

  graphSnapshot() {
    return `\`\`\`json${JSON.stringify(this.graph)}\`\`\``;
  }

  async appendMessage() {
    const userInput = this.userInput;
    this.userInput = "";

    const newGraph = [...this.graph];
    const symbols = collectSymbols(this.graph);
    symbols.reverse();

    const spec = await plan(userInput, prepareSteps(userInput));
    const finalPlan = spec?.[spec?.length - 1];
    console.log("finalPlan", finalPlan);
    const input = `Implement the following plan using the available tools: ${finalPlan?.content} --- Current graph: ${this.graphSnapshot()}`;

    const systemContext = `Prefer to send tool calls in serial rather than in one large block, this way we can show the user the nodes as they are created.`;

    this.graph = newGraph;

    const result = await processUserInput(
      input,
      codePrompt + systemContext,
      this.availableFunctions(newGraph)
    );
    console.log("result", result);

    this.graph = JSON.parse(JSON.stringify(newGraph));
    console.log("graph updated", this.graph);
  }

  override render() {
    const setUserInput = (input: string) => {
      this.userInput = input;
    };

    const setContext = (context: Context<any>) => {
      this.snapshot = snapshot(context);
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
