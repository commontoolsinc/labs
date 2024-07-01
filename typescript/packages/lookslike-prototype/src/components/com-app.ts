import { LitElement, html } from "lit-element";
import { customElement, state } from "lit/decorators.js";
import { base } from "../styles.js";

import { NodePath, Recipe, emptyGraph } from "../data.js";
import { collectSymbols } from "../graph.js";
import { Context, snapshot } from "../state.js";
import { watch } from "@commontools/common-frp-lit";
import {
  CONTENT_TYPE_CLOCK,
  CONTENT_TYPE_DATA,
  CONTENT_TYPE_EVENT,
  CONTENT_TYPE_FETCH,
  CONTENT_TYPE_GLSL,
  CONTENT_TYPE_JAVASCRIPT,
  CONTENT_TYPE_LLM,
  CONTENT_TYPE_SCENE,
  CONTENT_TYPE_STORAGE,
  CONTENT_TYPE_UI
} from "../contentType.js";
import { plan, prepareSteps } from "../agent/plan.js";
import { processUserInput } from "../agent/llm.js";
import { codePrompt } from "../agent/implement.js";
import { suggestions, thoughtLog } from "../agent/model.js";
import { LLMClient, LlmTool } from "@commontools/llm-client";
import { LLM_SERVER_URL } from "../llm-client.js";
import { ChatCompletionTool } from "openai/resources/index.mjs";
import { toolSpec } from "../agent/tools.js";

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

  generateToolSpec(
    toolSpec: ChatCompletionTool[],
    implementations: { [key: string]: (...inputs: any) => Promise<string> }
  ): LlmTool[] {
    return toolSpec
      .map((tool) => {
        const functionName = tool.function.name;
        const implementation = implementations[functionName];

        const { parameters, ...rest } = tool.function;

        if (implementation) {
          return {
            ...rest,
            input_schema: parameters as any,
            implementation
          };
        } else {
          console.warn(`No implementation found for function: ${functionName}`);
          return null;
        }
      })
      .filter((v) => v !== null);
  }

  availableFunctions(graph: Recipe) {
    const updateGraph = this.updateGraph.bind(this);

    return {
      listNodes: async () => {
        console.log("listNodes", this.graph);
        return JSON.stringify(this.graph);
      },
      addConnection: async ({ from, to }: { from: string; to: NodePath }) => {
        console.log("addConnection", from, to);
        const [toNodeId, toInputKey] = to;
        const fromNode = graph.find((node) => node.id === from);
        if (!fromNode) {
          return `Node ${from} not found.\n${this.graphSnapshot()}`;
        }
        const toNode = graph.find((node) => node.id === toNodeId);
        if (!toNode) {
          return `Node ${toNode} not found.\n${this.graphSnapshot()}`;
        }

        toNode.in[toInputKey] = [".", from];
        updateGraph(graph);
        return `Added connection from ${from} to ${to}.\n${this.graphSnapshot()}`;
      },
      declareDataNode: async ({ id, data }: { id: string; data: any }) => {
        console.log("declareDataNode", id, data);
        graph.push({
          id,
          contentType: CONTENT_TYPE_DATA,
          in: {},
          outputType: {},
          body: data
        });
      },
      addCodeNode: async (props: { id: string; code: string }) => {
        console.log("addCodeNode", props);
        const { id, code } = props;

        const existingNode = graph.find((node) => node.id === id);
        if (existingNode) {
          existingNode.body = code;
        } else {
          graph.push({
            id,
            contentType: CONTENT_TYPE_JAVASCRIPT,
            in: {},
            outputType: {},
            body: code
          });
        }

        updateGraph(graph);
        return `Added node: ${id}.\n${this.graphSnapshot()}`;
      },
      addUiNode: async (props: { id: string; uiTree: object }) => {
        console.log("addUiNode", props);
        const { id, uiTree } = props;

        const existingNode = graph.find((node) => node.id === id);
        if (existingNode) {
          existingNode.body = uiTree;
        } else {
          graph.push({
            id,
            contentType: CONTENT_TYPE_UI,
            in: {},
            outputType: {},
            body: uiTree
          });
        }
        updateGraph(graph);
        return `Added node: ${id}.\n${this.graphSnapshot()}`;
      },
      add3dVoxelSceneNode: async ({
        id,
        dataSource
      }: {
        id: string;
        dataSource: string;
      }) => {
        console.log("add3dVoxelSceneNode", id, dataSource);
        graph.push({
          id,
          contentType: CONTENT_TYPE_SCENE,
          in: {
            data: [".", dataSource]
          },
          outputType: {},
          body: {}
        });
        updateGraph(graph);
        return `Added node: ${id}.\n${this.graphSnapshot()}`;
      },
      addGlslShaderNode: async ({
        id,
        shaderToyCode
      }: {
        id: string;
        shaderToyCode: string;
      }) => {
        console.log("addGlslShaderNode", id, shaderToyCode);
        graph.push({
          id,
          contentType: CONTENT_TYPE_GLSL,
          in: {},
          outputType: {},
          body: shaderToyCode
        });
        updateGraph(graph);
        return `Added node: ${id}.\n${this.graphSnapshot()}`;
      },
      addFetchNode: async ({ id, url }: { id: string; url: string }) => {
        console.log("addFetchNode", id, url);
        graph.push({
          id,
          contentType: CONTENT_TYPE_FETCH,
          in: {},
          outputType: {
            type: "object"
          },
          body: url
        });
        updateGraph(graph);
        return `Added node: ${id}.\n${this.graphSnapshot()}`;
      },
      addClockNode: async ({ id }: { id: string }) => {
        console.log("addEventNode", id);
        graph.push({
          id,
          contentType: CONTENT_TYPE_CLOCK,
          in: {},
          outputType: {
            type: "object"
          },
          body: ""
        });
        updateGraph(graph);
        return `Added node: ${id}.\n${this.graphSnapshot()}`;
      },
      addLanguageModelNode: async ({
        id,
        promptSource
      }: {
        id: string;
        promptSource: string;
      }) => {
        console.log("addLanguageModelNode", id, prompt);
        graph.push({
          id,
          contentType: CONTENT_TYPE_LLM,
          in: {
            prompt: [".", promptSource]
          },
          outputType: {
            type: "string"
          },
          body: ""
        });
        updateGraph(graph);
        return `Added node: ${id}.\n${this.graphSnapshot()}`;
      },
      addImageGenerationNode: async ({
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
        updateGraph(graph);
        return `Added node: ${id}.\n${this.graphSnapshot()}`;
      },
      deleteNode: async ({ id }: { id: string }) => {
        console.log("deleteNode", id);
        const index = graph.findIndex((n) => n.id === id);
        graph.splice(index, 1);
        updateGraph(graph);
        return `Deleted node: ${id}.\n${this.graphSnapshot()}`;
      }
    };
  }

  updateGraph(graph: Recipe) {
    // loop over graph and dedupe and repeated IDs, preferring the last one
    // preserve the original ordering
    console.log("deduping", graph);
    const deduped = graph.reduce((acc, node) => {
      const index = acc.findIndex((n) => n.id === node.id);
      if (index !== -1) {
        acc[index] = node;
      } else {
        acc.push(node);
      }
      return acc;
    }, [] as Recipe);

    console.log("deduped graph", deduped);

    this.graph = JSON.parse(JSON.stringify(deduped));
    this.requestUpdate();
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

    const spec = await plan(userInput, prepareSteps(userInput, this.graph));
    const finalPlan = spec?.[spec?.length - 1];
    console.log("finalPlan", finalPlan);
    const input = `Implement the following plan using the available tools: ${finalPlan}
    ---
    Current graph (may be empty): ${this.graphSnapshot()}`;

    // const systemContext = `Prefer to send tool calls in serial rather than in one large block, this way we can show the user the nodes as they are created.`;
    const systemContext = ``;

    this.graph = newGraph;

    const client = new LLMClient({
      serverUrl: LLM_SERVER_URL,
      tools: this.generateToolSpec(
        toolSpec,
        this.availableFunctions(this.graph)
      ),
      system: codePrompt + systemContext
    });

    const thread = await client.createThread(input);
    const result = thread.conversation[thread.conversation.length - 1];

    console.log("result", result);
  }

  override render() {
    const setUserInput = (input: string) => {
      this.userInput = input;
    };

    const setContext = (context: Context<any>) => {
      this.snapshot = snapshot(context);
    };

    return html`
      <main>
        <com-chat slot="main">
          <com-thread
            slot="main"
            .graph=${this.graph}
            .setContext=${setContext}
          ></com-thread>
          <div slot="footer">
            <com-unibox
              .suggestions=${watch(suggestions)}
              @suggested=${(ev) => {
                this.userInput = ev.detail.suggestion;
                this.appendMessage();
                suggestions.send([]);
              }}
            >
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
        <com-debug>
          <com-thought-log .thoughts=${watch(thoughtLog)}></com-thought-log>
        </com-debug>
      </main>
    `;
  }
}
