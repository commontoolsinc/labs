import { LitElement, html } from "lit-element";
import { customElement, state } from "lit/decorators.js";
import { base } from "../styles.js";

import { collectSymbols } from "../graph.js";
import { Context, snapshot } from "../state.js";
import { watch } from "@commontools/common-frp-lit";
import {
  CONTENT_TYPE_CLOCK,
  CONTENT_TYPE_DATA,
  CONTENT_TYPE_EVENT,
  CONTENT_TYPE_FETCH,
  CONTENT_TYPE_GLSL,
  CONTENT_TYPE_IMAGE,
  CONTENT_TYPE_JAVASCRIPT,
  CONTENT_TYPE_LLM,
  CONTENT_TYPE_SCENE,
  CONTENT_TYPE_STORAGE,
  CONTENT_TYPE_UI
} from "../contentType.js";
import { plan, prepareSteps } from "../agent/plan.js";
import { codePrompt } from "../agent/implement.js";
import { suggestions, thoughtLog } from "../agent/model.js";
import { LLMClient, LlmTool } from "@commontools/llm-client";
import { LLM_SERVER_URL } from "../llm-client.js";
import { ChatCompletionTool } from "openai/resources/index.mjs";
import { toolSpec } from "../agent/tools.js";
import { ReactiveGraph } from "../data.js";

export const appGraph = new ReactiveGraph(
  {
    node: {
      id: "root",
      body: "() => 1 + 1",
      contentType: CONTENT_TYPE_JAVASCRIPT
    },
    children: [],
    content: ["hello world"]
  },
  {}
);

@customElement("com-app")
export class ComApp extends LitElement {
  static override styles = [base];

  static override properties = {
    userInput: { type: String }
  };

  @state() userInput = "";

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

  availableFunctions(graph: ReactiveGraph) {
    return {
      listNodes: async () => {
        console.log("listNodes", graph);
        return JSON.stringify(graph);
      },
      addConnection: async ({
        from,
        to,
        portName
      }: {
        from: string;
        to: string;
        portName: string;
      }) => {
        console.log("addConnection", from, to, portName);
        graph.addConnection(from, to, portName);
        return `Added connection from ${from} to ${to}.\n${this.graphSnapshot()}`;
      },
      declareDataNode: async ({ id, data }: { id: string; data: any }) => {
        console.log("declareDataNode", id, data);
        graph.addNode(
          {
            id,
            contentType: CONTENT_TYPE_DATA,
            body: data
          },
          [],
          "root"
        );

        return `Added data node: ${id}.\n${this.graphSnapshot()}`;
      },
      addCodeNode: async (props: {
        id: string;
        code: string;
        documentatedReasoning: string;
      }) => {
        console.log("addCodeNode", props);
        const { id, code, documentatedReasoning } = props;
        graph.addNode(
          {
            id,
            contentType: CONTENT_TYPE_JAVASCRIPT,
            body: code
          },
          [documentatedReasoning],
          "root"
        );
        return `Added node: ${id}.\n${this.graphSnapshot()}`;
      },
      addUiNode: async (props: {
        id: string;
        uiTree: object;
        documentatedReasoning: string;
      }) => {
        console.log("addUiNode", props);
        const { id, uiTree, documentatedReasoning } = props;
        graph.addNode(
          {
            id,
            contentType: CONTENT_TYPE_UI,
            body: uiTree
          },
          [documentatedReasoning],
          "root"
        );
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
        graph.addNode(
          {
            id,
            contentType: CONTENT_TYPE_SCENE,
            body: {}
          },
          [],
          "root"
        );

        graph.addConnection(dataSource, id, "data");
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
        graph.addNode(
          {
            id,
            contentType: CONTENT_TYPE_GLSL,
            body: shaderToyCode
          },
          [],
          "root"
        );
        return `Added node: ${id}.\n${this.graphSnapshot()}`;
      },
      addFetchNode: async ({ id, url }: { id: string; url: string }) => {
        console.log("addFetchNode", id, url);
        graph.addNode(
          {
            id,
            contentType: CONTENT_TYPE_FETCH,
            body: url
          },
          [],
          "root"
        );
        return `Added node: ${id}.\n${this.graphSnapshot()}`;
      },
      addClockNode: async ({ id }: { id: string }) => {
        console.log("addEventNode", id);
        graph.addNode(
          {
            id,
            contentType: CONTENT_TYPE_CLOCK,
            body: {}
          },
          [],
          "root"
        );
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
        graph.addNode(
          {
            id,
            contentType: CONTENT_TYPE_LLM,
            body: {}
          },
          [],
          "root"
        );

        graph.addConnection(promptSource, id, "prompt");
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
        graph.addNode(
          {
            id,
            contentType: CONTENT_TYPE_IMAGE,
            body: {}
          },
          [],
          "root"
        );

        graph.addConnection(promptSource, id, "prompt");
        return `Added node: ${id}.\n${this.graphSnapshot()}`;
      },
      deleteNode: async ({ id }: { id: string }) => {
        console.log("deleteNode", id);
        graph.removeNode(id);
        return `Deleted node: ${id}.\n${this.graphSnapshot()}`;
      }
    };
  }

  graphSnapshot() {
    return appGraph.snapshot();
  }

  async appendMessage() {
    const userInput = this.userInput;
    this.userInput = "";

    const spec = await plan(userInput, prepareSteps(userInput, appGraph));
    const finalPlan = spec?.[spec?.length - 1];
    console.log("finalPlan", finalPlan);
    const input = `Implement the following plan using the available tools: ${finalPlan}
    ---
    Current graph (may be empty): ${this.graphSnapshot()}`;

    // const systemContext = `Prefer to send tool calls in serial rather than in one large block, this way we can show the user the nodes as they are created.`;
    const systemContext = ``;

    const client = new LLMClient({
      serverUrl: LLM_SERVER_URL,
      tools: this.generateToolSpec(toolSpec, this.availableFunctions(appGraph)),
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

    return html`
      <main>
        <com-chat slot="main">
          <com-thread slot="main"></com-thread>
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
