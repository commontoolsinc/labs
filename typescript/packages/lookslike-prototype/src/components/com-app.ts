import { LitElement, html } from "lit-element";
import { customElement, state } from "lit/decorators.js";
import { base } from "../styles.js";
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
import { suggestions } from "../agent/model.js";
import { LLMClient, LlmTool } from "@commontools/llm-client";
import { LLM_SERVER_URL } from "../llm-client.js";
import { ChatCompletionTool } from "openai/resources/index.mjs";
import { toolSpec } from "../agent/tools.js";
import { computed, reactive } from "@vue/reactivity";
import { Graph } from "../reactivity/runtime.js";
import { Recipe, SpecTree } from "../data.js";
import { cursor } from "../agent/cursor.js";
import { watch } from "../reactivity/watch.js";

export const appPlan: SpecTree = reactive({
  history: [],
  steps: []
});
export const appState = reactive({} as any);
export const appGraph = new Graph(appState);
// appGraph.load({
//   nodes: [
//     {
//       id: "counter",
//       contentType: "application/json+vnd.common.data",
//       body: "0"
//     },
//     {
//       id: "increment",
//       contentType: "text/javascript",
//       body: "return input('count') + 1;",
//       evalMode: "ses"
//     },
//     {
//       id: "button",
//       contentType: "application/json+vnd.common.ui",
//       body: {
//         tag: "button",
//         props: {
//           "@click": {
//             "@type": "binding",
//             name: "increment"
//           },
//           innerText: {
//             "@type": "binding",
//             name: "count"
//           }
//         },
//         children: []
//       }
//     }
//   ],
//   connections: {
//     counter: {
//       incrementEvent: "increment"
//     },
//     increment: {
//       count: "counter"
//     },
//     button: {
//       count: "counter"
//     }
//   },
//   spec: {
//     history: [],
//     steps: [
//       {
//         description: "Increment the counter",
//         associatedNodes: ["increment", "counter"]
//       },
//       {
//         description: "Display the counter",
//         associatedNodes: ["button", "counter"]
//       }
//     ]
//   },
//   outputs: [],
//   inputs: []
// });

window.__refresh = () => {
  appGraph.update();
};

export const stateSnapshot = computed(() => JSON.stringify(appState, null, 2));

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

  availableFunctions(graph: Graph) {
    return {
      listNodes: async () => {
        console.log("listNodes", graph);
        return JSON.stringify(graph);
      },
      addStepToSpecification: async ({
        description,
        associatedNodes
      }: {
        description: string;
        associatedNodes: string[];
      }) => {
        console.log("addStepToSpecification", description, associatedNodes);
        appPlan.steps = [
          ...appPlan.steps,
          {
            description,
            associatedNodes
          }
        ];
        return `Added step: ${description}.\n${this.graphSnapshot()}`;
      },
      connect: async ({
        from,
        to,
        portName
      }: {
        from: string;
        to: string;
        portName: string;
      }) => {
        console.log("connect", from, to, portName);
        graph.connect(from, to, portName);
        return `Added connection from ${from} to ${to}.\n${this.graphSnapshot()}`;
      },
      data: async ({
        id,
        data,
        documentedReasoning
      }: {
        id: string;
        data: any;
        documentedReasoning: string;
      }) => {
        console.log("data", id, data);
        graph.add(id, {
          id,
          contentType: CONTENT_TYPE_DATA,
          body: data
        });

        appPlan.steps = [
          ...appPlan.steps,
          {
            description: documentedReasoning,
            associatedNodes: [id]
          }
        ];

        return `Added data node: ${id}.\n${this.graphSnapshot()}`;
      },
      func: async (props: {
        id: string;
        code: string;
        documentedReasoning: string;
      }) => {
        console.log("addCodeNode", props);
        const { id, code, documentedReasoning } = props;
        graph.add(id, {
          id,
          contentType: CONTENT_TYPE_JAVASCRIPT,
          body: code
        });
        appPlan.steps = [
          ...appPlan.steps,
          {
            description: documentedReasoning,
            associatedNodes: [id]
          }
        ];
        return `Added node: ${id}.\n${this.graphSnapshot()}`;
      },
      ui: async (props: {
        id: string;
        uiTree: object;
        documentedReasoning: string;
      }) => {
        console.log("addUiNode", props);
        const { id, uiTree, documentedReasoning } = props;
        graph.add(id, {
          id,
          contentType: CONTENT_TYPE_UI,
          body: uiTree
        });
        appPlan.steps = [
          ...appPlan.steps,
          {
            description: documentedReasoning,
            associatedNodes: [id]
          }
        ];
        return `Added node: ${id}.\n${this.graphSnapshot()}`;
      },
      voxel3dScene: async ({
        id,
        dataSource,
        documentedReasoning
      }: {
        id: string;
        dataSource: string;
        documentedReasoning: string;
      }) => {
        console.log("add3dVoxelSceneNode", id, dataSource);
        graph.add(id, {
          id,
          contentType: CONTENT_TYPE_SCENE,
          body: {}
        });
        appPlan.steps = [
          ...appPlan.steps,
          {
            description: documentedReasoning,
            associatedNodes: [id]
          }
        ];

        graph.connect(dataSource, id, "data");
        return `Added node: ${id}.\n${this.graphSnapshot()}`;
      },
      glslShader: async ({
        id,
        shaderToyCode,
        documentedReasoning
      }: {
        id: string;
        shaderToyCode: string;
        documentedReasoning: string;
      }) => {
        console.log("addGlslShaderNode", id, shaderToyCode);
        graph.add(id, {
          id,
          contentType: CONTENT_TYPE_GLSL,
          body: shaderToyCode
        });
        appPlan.steps = [
          ...appPlan.steps,
          {
            description: documentedReasoning,
            associatedNodes: [id]
          }
        ];
        return `Added node: ${id}.\n${this.graphSnapshot()}`;
      },
      fetch: async ({ id, url }: { id: string; url: string }) => {
        console.log("addFetchNode", id, url);
        graph.add(id, {
          id,
          contentType: CONTENT_TYPE_FETCH,
          body: url
        });
        return `Added node: ${id}.\n${this.graphSnapshot()}`;
      },
      clock: async ({ id }: { id: string }) => {
        console.log("addClockNode", id);
        graph.add(id, {
          id,
          contentType: CONTENT_TYPE_CLOCK,
          body: {}
        });
        return `Added node: ${id}.\n${this.graphSnapshot()}`;
      },
      languageModel: async ({
        id,
        promptSource
      }: {
        id: string;
        promptSource: string;
      }) => {
        console.log("addLanguageModelNode", id, prompt);
        graph.add(id, {
          id,
          contentType: CONTENT_TYPE_LLM,
          body: {}
        });

        graph.connect(promptSource, id, "prompt");
        return `Added node: ${id}.\n${this.graphSnapshot()}`;
      },
      imageGeneration: async ({
        id,
        promptSource
      }: {
        id: string;
        promptSource: string;
      }) => {
        console.log("addImageGenerationNode", id, prompt);
        graph.add(id, {
          id,
          contentType: CONTENT_TYPE_IMAGE,
          body: {}
        });

        graph.connect(promptSource, id, "prompt");
        return `Added node: ${id}.\n${this.graphSnapshot()}`;
      },
      delete: async ({ id }: { id: string }) => {
        console.log("deleteNode", id);
        graph.delete(id);
        return `Deleted node: ${id}.\n${this.graphSnapshot()}`;
      }
    };
  }

  graphSnapshot() {
    return JSON.stringify(appGraph.save(), null, 2);
  }

  async appendMessage(userInput: string) {
    cursor.state = "thinking";

    if (cursor.focus.length > 0) {
      userInput = `<user-selection>[${cursor.focus.map((f) => f.id).join(", ")}</user-selection> \n<user-input>${userInput}</user-input>`;
    }

    const spec = await plan(userInput, prepareSteps(userInput, appGraph));
    const finalPlan = spec?.[spec?.length - 1];
    console.log("finalPlan", finalPlan);
    const input = `Implement the following plan using the available tools: ${finalPlan}
    ---
    Current graph (may be empty): ${this.graphSnapshot()}`;

    const systemContext = `Prefer to send tool calls in serial rather than in one large block, this way we can show the user the nodes as they are created.`;
    // const systemContext = ``;

    const client = new LLMClient({
      serverUrl: LLM_SERVER_URL,
      tools: this.generateToolSpec(toolSpec, this.availableFunctions(appGraph)),
      system: codePrompt + systemContext
    });

    cursor.state = "working";
    const thread = await client.createThread(input);
    const result = thread.conversation[thread.conversation.length - 1];
    appGraph.update();
    window.__snapshot = appGraph.save();

    cursor.state = "idle";

    console.log("result", result);
  }

  override render() {
    const onCursorMessage = (ev: CustomEvent) => {
      this.appendMessage(ev.detail.message);
    };

    return html`
      <main>
        <com-cursor
          .suggestions=${watch(suggestions)}
          @message=${onCursorMessage}
        ></com-cursor>
        <com-chat slot="main">
          <com-thread slot="main"></com-thread>
        </com-chat>
        <com-debug>
          <pre>${watch(stateSnapshot)}</pre>
        </com-debug>
      </main>
    `;
  }
}
