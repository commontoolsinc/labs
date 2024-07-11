import { LitElement, html } from "lit-element";
import { customElement, state } from "lit/decorators.js";
import { base } from "../styles.js";
import {
  CONTENT_TYPE_CLOCK,
  CONTENT_TYPE_DATA,
  CONTENT_TYPE_EVENT,
  CONTENT_TYPE_EVENT_LISTENER,
  CONTENT_TYPE_FETCH,
  CONTENT_TYPE_GLSL,
  CONTENT_TYPE_IMAGE,
  CONTENT_TYPE_JAVASCRIPT,
  CONTENT_TYPE_LLM,
  CONTENT_TYPE_SCENE,
  CONTENT_TYPE_STORAGE,
  CONTENT_TYPE_UI
} from "../contentType.js";
import {
  makeConsistent,
  plan,
  planIdentifiers,
  prepareSteps,
  sketchHighLevelApproachPrompt
} from "../agent/plan.js";
import { codePrompt } from "../agent/implement.js";
import { recordThought, suggestions } from "../agent/model.js";
import { LLMClient, LlmTool } from "@commontools/llm-client";
import { LLM_SERVER_URL } from "../llm-client.js";
import { ChatCompletionTool } from "openai/resources/index.mjs";
import { toolSpec } from "../agent/tools.js";
import { computed, reactive } from "@vue/reactivity";
import { Graph } from "../reactivity/runtime.js";
import { cursor } from "../agent/cursor.js";
import { watch } from "../reactivity/watch.js";
import { grabAllTags, grabTag } from "../agent/llm.js";
import { css } from "lit";
import { Message } from "../data.js";

export const session = reactive({
  history: [] as Message[]
});

export const appState = reactive({} as any);
export const appGraph = new Graph(appState);
export const appDocument = reactive({
  content: `<step>Imagine something</step>`,
  requests: [] as string[]
});

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
export const requestsList = computed(
  () =>
    html`<ul>
      ${appDocument.requests.map((r) => html`<li>${r}</li>`)}
    </ul>`
);

@customElement("com-app")
export class ComApp extends LitElement {
  static override styles = [
    base,
    css`
      main {
        display: flex;
      }

      main > * {
        flex: 1;
        max-width: 50%;
        overflow-x: auto;
      }
    `
  ];

  static override properties = {
    userInput: { type: String }
  };

  @state() userInput = "";
  @state() modifying = false;

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
          body: data,
          comment: documentedReasoning
        });

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
          body: code,
          comment: documentedReasoning
        });

        return `Added node: ${id}.\n${this.graphSnapshot()}`;
      },
      listen: async (props: {
        event: string;
        id: string;
        code: string;
        documentedReasoning: string;
      }) => {
        console.log("addListener", props);
        const { id, event, code, documentedReasoning } = props;
        graph.add(id, {
          id,
          contentType: CONTENT_TYPE_EVENT_LISTENER,
          body: {
            event,
            code
          },
          comment: documentedReasoning
        });

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
          body: uiTree,
          comment: documentedReasoning
        });

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
          body: {},
          comment: documentedReasoning
        });

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
          body: shaderToyCode,
          comment: documentedReasoning
        });
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
    const g = appGraph.save();
    const preview = {
      nodes: g.nodes,
      connections: g.connections
    };

    return JSON.stringify(preview, null, 2);
  }

  async planResponse(userInput: string) {
    cursor.state = "sketching";
    const baseInput = userInput;

    if (cursor.focus.length > 0) {
      userInput = `<user-selection>${cursor.focus.map((f) => f.id).join(", ")}</user-selection> ${userInput}`;
    }

    appDocument.requests.push(userInput);
    const snapshot = this.graphSnapshot();

    const { system, prompt } = sketchHighLevelApproachPrompt(
      appDocument.requests,
      appDocument.content,
      snapshot
    );
    const client = new LLMClient({
      serverUrl: LLM_SERVER_URL,
      tools: [],
      system
    });

    const res = await client.createThread(prompt);
    const last = res.conversation[res.conversation.length - 1];
    const plan = grabTag(last, "plan");
    recordThought({ role: "assistant", content: plan });

    appDocument.content = plan;

    const identifiers = grabAllTags(plan, "identifier");
    if (identifiers.length == 0) {
      const steps = grabAllTags(plan, "step");

      cursor.state = "detailing";

      const enrichedSteps = await Promise.all(
        steps.map(async (step) => {
          const { system, prompt } = planIdentifiers(
            step,
            appDocument.requests,
            appDocument.content,
            snapshot
          );
          const client = new LLMClient({
            serverUrl: LLM_SERVER_URL,
            tools: [],
            system
          });

          const res = await client.createThread(prompt);
          const last = res.conversation[res.conversation.length - 1];
          const enriched = grabTag(last, "result");
          recordThought({ role: "assistant", content: enriched });
          return enriched;
        })
      );

      appDocument.content = `<plan>
        ${enrichedSteps.join("\n")}
      </plan>`;
    }

    cursor.state = "idle";
  }

  async modifyGraph() {
    this.modifying = true;

    async function reflect() {
      const { system, prompt } = makeConsistent(
        appDocument.content,
        appDocument.requests
      );
      const client = new LLMClient({
        serverUrl: LLM_SERVER_URL,
        tools: [],
        system
      });

      const res = await client.createThread(prompt);
      const last = res.conversation[res.conversation.length - 1];
      const plan = grabTag(last, "corrected-plan");
      recordThought({ role: "assistant", content: plan });
      appDocument.content = plan;
      return plan;
    }

    cursor.state = "reflecting";

    const finalPlan = await reflect();

    // const spec = await plan(userInput, prepareSteps(userInput, appGraph));
    // const finalPlan = spec?.[spec?.length - 1];
    // console.log("finalPlan", finalPlan);
    const input = `Implement the following plan using the available tools:

    <plan>
      ${finalPlan}
    </plan>

    Current graph (may be empty): ${this.graphSnapshot()}

    Modify or create the graph to make it align with the plan and say nothing in response.`;

    // const systemContext = `Prefer to send tool calls in serial rather than in one large block, this way we can show the user the nodes as they are created.`;
    const systemContext = ``;

    const implement = async () => {
      const client = new LLMClient({
        serverUrl: LLM_SERVER_URL,
        tools: this.generateToolSpec(
          toolSpec,
          this.availableFunctions(appGraph)
        ),
        system: codePrompt + systemContext
      });

      const thread = await client.createThread(input);
      const result = thread.conversation[thread.conversation.length - 1];
      recordThought({ role: "assistant", content: result });
    };

    if (!this.modifying) {
      cursor.state = "idle";
      return;
    }

    cursor.state = "working";

    await implement();

    appGraph.update();
    window.__snapshot = appGraph.save();

    cursor.state = "idle";
    this.modifying = false;
  }

  override render() {
    const onCursorMessage = (ev: CustomEvent) => {
      this.planResponse(ev.detail.message);
    };

    const onCursorToggled = (ev: CustomEvent) => {
      if (this.modifying) {
        this.modifying = false;
      } else {
        this.modifyGraph();
      }
    };

    return html`
      <main>
        <com-cursor
          .suggestions=${watch(suggestions)}
          @message=${onCursorMessage}
          @toggled=${onCursorToggled}
        ></com-cursor>
        <div>
          <section>${watch(requestsList)}</section>
          <com-document-editor></com-document-editor>
        </div>
        <com-chat>
          <com-thread slot="main"></com-thread>
        </com-chat>
        <com-debug>
          <pre>${watch(stateSnapshot)}</pre>
        </com-debug>
      </main>
    `;
  }
}
