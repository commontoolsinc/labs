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
  CONTENT_TYPE_PLACEHOLDER,
  CONTENT_TYPE_SCENE,
  CONTENT_TYPE_STORAGE,
  CONTENT_TYPE_UI
} from "../contentType.js";
import {
  fixGraph,
  makeConsistent,
  plan,
  planIdentifiers,
  prepareSteps,
  sketchHighLevelApproachPrompt,
  sketchReactVersion,
  transformToGraph
} from "../agent/plan.js";
import { examples } from "../agent/implement.js";
import { recordThought, suggestions } from "../agent/model.js";
import { LLMClient, LlmTool } from "@commontools/llm-client";
import { LLM_SERVER_URL } from "../llm-client.js";
import { ChatCompletionTool } from "openai/resources/index.mjs";
import { planningToolSpec, toolSpec } from "../agent/tools.js";
import { computed, reactive } from "@vue/reactivity";
import { Graph } from "../reactivity/runtime.js";
import { cursor } from "../agent/cursor.js";
import { watch } from "../reactivity/watch.js";
import {
  grabAllTags,
  grabJavascript,
  grabJson,
  grabMarkdown,
  grabTag
} from "../agent/llm.js";
import { css } from "lit";
import { Message } from "../data.js";

export const session = reactive({
  history: [] as Message[],
  requests: [] as string[]
});

export const idk = reactive({
  reactCode: "a",
  speclang: "b",
  transformed: "c"
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
export const requestsList = computed(
  () =>
    html`<ul>
      ${session.requests.map((r) => html`<li>${r}</li>`)}
    </ul>`
);

@customElement("com-app")
export class ComApp extends LitElement {
  static override styles = [
    base,
    css`
      main {
        display: flex;
        flex-direction: column;
      }

      .requests {
        font-size: 1.5em;
        font-family: "Palatino", "Georgia", serif;
        padding: 1em;
      }

      .plan {
        display: flex;
        flex-direction: row;
      }

      .plan > * {
        flex: 1;
        padding: 2rem;
        overflow: auto;
        border-right: 1px solid #ccc;
      }

      .plan > *:last-child {
        border-right: none;
      }

      .plan > pre {
        font-family: monospace;
        font-size: 0.8rem;
      }

      .plan com-chat {
        flex: 3;
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
        return `Added connection from ${from} to ${to}.`;
      },
      data: async ({
        id,
        data,
        docstring
      }: {
        id: string;
        data: any;
        docstring: string;
      }) => {
        console.log("data", id, data);
        graph.add(id, {
          id,
          contentType: CONTENT_TYPE_DATA,
          body: data,
          docstring
        });

        return `Added data node: ${id}.`;
      },
      placeholder: async (props: { id: string; docstring: string }) => {
        console.log("placeholder", props);
        const { id, docstring } = props;
        graph.add(id, {
          id,
          contentType: CONTENT_TYPE_PLACEHOLDER,
          body: "",
          docstring
        });

        return `Added node: ${id}.`;
      },
      declareFunc: async (props: { id: string; docstring: string }) => {
        console.log("declareFunc", props);
        const { id, docstring } = props;
        graph.add(id, {
          id,
          contentType: CONTENT_TYPE_JAVASCRIPT,
          body: "",
          docstring
        });

        return `Added node: ${id}.`;
      },
      func: async (props: { id: string; code: string; docstring: string }) => {
        console.log("addCodeNode", props);
        const { id, code, docstring } = props;
        graph.add(id, {
          id,
          contentType: CONTENT_TYPE_JAVASCRIPT,
          body: code,
          docstring
        });

        return `Added node: ${id}.`;
      },
      listen: async (props: {
        event: string;
        id: string;
        code: string;
        docstring: string;
      }) => {
        console.log("addListener", props);
        const { id, event, code, docstring } = props;
        graph.add(id, {
          id,
          contentType: CONTENT_TYPE_EVENT_LISTENER,
          body: {
            event,
            code
          },
          docstring: docstring
        });

        return `Added node: ${id}.`;
      },
      ui: async (props: { id: string; uiTree: object; docstring: string }) => {
        console.log("addUiNode", props);
        const { id, uiTree, docstring } = props;
        graph.add(id, {
          id,
          contentType: CONTENT_TYPE_UI,
          body: uiTree,
          docstring
        });

        return `Added node: ${id}.`;
      },
      voxel3dScene: async ({
        id,
        dataSource,
        docstring
      }: {
        id: string;
        dataSource: string;
        docstring: string;
      }) => {
        console.log("add3dVoxelSceneNode", id, dataSource);
        graph.add(id, {
          id,
          contentType: CONTENT_TYPE_SCENE,
          body: {},
          docstring
        });

        graph.connect(dataSource, id, "data");
        return `Added node: ${id}.`;
      },
      glslShader: async ({
        id,
        shaderToyCode,
        docstring
      }: {
        id: string;
        shaderToyCode: string;
        docstring: string;
      }) => {
        console.log("addGlslShaderNode", id, shaderToyCode);
        graph.add(id, {
          id,
          contentType: CONTENT_TYPE_GLSL,
          body: shaderToyCode,
          docstring
        });
        return `Added node: ${id}.`;
      },
      // fetch: async ({ id, url }: { id: string; url: string }) => {
      //   console.log("addFetchNode", id, url);
      //   graph.add(id, {
      //     id,
      //     contentType: CONTENT_TYPE_FETCH,
      //     body: url,
      //   });
      //   return `Added node: ${id}.\n${this.graphSnapshot()}`;
      // },
      // clock: async ({ id }: { id: string }) => {
      //   console.log("addClockNode", id);
      //   graph.add(id, {
      //     id,
      //     contentType: CONTENT_TYPE_CLOCK,
      //     body: {}
      //   });
      //   return `Added node: ${id}.\n${this.graphSnapshot()}`;
      // },
      // languageModel: async ({
      //   id,
      //   promptSource
      // }: {
      //   id: string;
      //   promptSource: string;
      // }) => {
      //   console.log("addLanguageModelNode", id, prompt);
      //   graph.add(id, {
      //     id,
      //     contentType: CONTENT_TYPE_LLM,
      //     body: {}
      //   });

      //   graph.connect(promptSource, id, "prompt");
      //   return `Added node: ${id}.\n${this.graphSnapshot()}`;
      // },
      // imageGeneration: async ({
      //   id,
      //   promptSource
      // }: {
      //   id: string;
      //   promptSource: string;
      // }) => {
      //   console.log("addImageGenerationNode", id, prompt);
      //   graph.add(id, {
      //     id,
      //     contentType: CONTENT_TYPE_IMAGE,
      //     body: {}
      //   });

      //   graph.connect(promptSource, id, "prompt");
      //   return `Added node: ${id}.\n${this.graphSnapshot()}`;
      // },
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

    session.requests.push(userInput);
    const snapshot = this.graphSnapshot();
    const recipe = await appGraph.save();

    const planningTools = this.generateToolSpec(
      planningToolSpec,
      this.availableFunctions(appGraph)
    );

    async function react() {
      const { system, prompt } = sketchReactVersion(session.requests);

      const client = new LLMClient({
        serverUrl: LLM_SERVER_URL,
        tools: [],
        system
      });

      const res = await client.createThread(prompt);
      const last = res.conversation[res.conversation.length - 1];
      recordThought({ role: "assistant", content: last });

      idk.reactCode = last;

      return last;
    }

    const sourceCode = await react();

    cursor.state = "detailing";

    async function transform() {
      const { system, prompt } = transformToGraph(sourceCode);

      const client = new LLMClient({
        serverUrl: LLM_SERVER_URL,
        tools: [],
        system
      });

      const res = await client.createThread(prompt);
      const last = res.conversation[res.conversation.length - 1];
      recordThought({ role: "assistant", content: last });

      const spec = grabMarkdown(last);
      const code = grabJavascript(last);

      idk.transformed = code;
      idk.speclang = spec;

      return last;
    }

    const transformed = await transform();
    console.log(transformed);

    cursor.state = "working";

    const refresh = this.requestUpdate.bind(this);

    async function building() {
      type Id = string;
      type PortName = string;

      type Bindings = {
        inputs: [PortName]; // named arguments for this node
        outputs: { [target: Id]: PortName }; // bindings for the output of this node
      };

      const code = idk.transformed;
      let errors = [] as string[];
      const allBindings = {} as { [id: Id]: Bindings };

      // stub any call to just log
      try {
        const context = new Function(
          "actions",
          `
          const { addState, addTransformation, addUi, addEventListener } = actions;
          ${code};
        `
        );

        context({
          addState(
            id: Id,
            explanation: string,
            initial: any,
            bindings: Bindings
          ) {
            console.log("addState", id, explanation, initial, bindings);
            appGraph.add(id, {
              id,
              contentType: CONTENT_TYPE_DATA,
              body: initial,
              docstring: explanation
            });
            allBindings[id] = bindings;
            refresh();
          },
          addTransformation(
            id: Id,
            explanation: string,
            code: string,
            bindings: Bindings
          ) {
            console.log("addTransformation", id, explanation, code, bindings);
            appGraph.add(id, {
              id,
              contentType: CONTENT_TYPE_JAVASCRIPT,
              body: code,
              docstring: explanation
            });
            allBindings[id] = bindings;
            refresh();
          },
          addUi(
            id: Id,
            explanation: string,
            template: string,
            bindings: Bindings
          ) {
            console.log("addUi", id, explanation, template, bindings);
            appGraph.add(id, {
              id,
              contentType: CONTENT_TYPE_UI,
              body: template,
              docstring: explanation
            });
            allBindings[id] = bindings;
            refresh();
          },
          addEventListener(
            id: Id,
            explanation: string,
            event: string,
            code: string,
            bindings: Bindings
          ) {
            console.log(
              "addEventListener",
              id,
              explanation,
              event,
              code,
              bindings
            );
            appGraph.add(id, {
              id,
              contentType: CONTENT_TYPE_EVENT_LISTENER,
              body: {
                event,
                code
              },
              docstring: explanation
            });
            allBindings[id] = bindings;
            refresh();
          }
        });
      } catch (e: any) {
        errors.push(`Creation failed: ${e.message}`);
      }

      for (const id in allBindings) {
        const bindings = allBindings[id];
        for (const target in bindings.outputs) {
          const port = bindings.outputs[target];
          appGraph.connect(id, target, port);
        }
      }

      // pass over all input bindings and check they have been wired
      for (const id in allBindings) {
        const bindings = allBindings[id];
        for (const input of bindings.inputs) {
          if (!appGraph.nodes.get(id)?.inputs.get(input)) {
            errors.push(`Node ${id} is missing input ${input}`);
            console.error(`Node ${id} is missing input ${input}`);
          }
        }
      }

      if (errors.length > 0) {
        const { system, prompt } = fixGraph(
          idk.transformed,
          idk.speclang,
          errors
        );

        const client = new LLMClient({
          serverUrl: LLM_SERVER_URL,
          tools: [],
          system
        });

        const res = await client.createThread(prompt);
        const last = res.conversation[res.conversation.length - 1];
        recordThought({ role: "assistant", content: last });

        const spec = grabMarkdown(last);
        const code = grabJavascript(last);

        idk.transformed = code;
        idk.speclang = spec;

        return false;
      }

      return true;
    }

    let passedCheck = await building();
    if (!passedCheck) {
      passedCheck = await building();
    }

    cursor.state = "idle";

    appGraph.update();
    this.requestUpdate();
  }

  async implementNode(id: string) {
    this.modifying = true;

    // const spec = await plan(userInput, prepareSteps(userInput, appGraph));
    // const finalPlan = spec?.[spec?.length - 1];
    // console.log("finalPlan", finalPlan);
    const input = `You are working with a user to modify a disposable software application. The environment is a reactive graph computation model. Modules, a.k.a nodes, connect with each other, where the output of one or more nodes serves as the input to another.

      The current program is as follows:

      <program>
      ${this.graphSnapshot()}
      </program>

      Implementation always looks like: data -> mapping functions -> UI and view nodes -> event listeners -> data. Functions must be pure and self-contained, they cannot reference one another except via connection.

      Your task is to implement the following node: \`${id}\`.
      You should ensure all inbound connections are correct as part of implementation.

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
        system: examples + systemContext
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

    this.requestUpdate();
  }

  override render() {
    const onCursorMessage = (ev: CustomEvent) => {
      this.planResponse(ev.detail.message);
    };

    const onImplement = () => {
      // check for selection
      if (cursor.focus.length === 0) {
        // implement all
        appGraph.nodes.forEach((n) => {
          this.implementNode(n.id);
        });
      } else {
        // implement selection
        cursor.focus.forEach((f) => {
          this.implementNode(f.id);
        });
      }
    };

    return html`
      <main>
        <com-cursor
          .suggestions=${watch(suggestions)}
          @message=${onCursorMessage}
          @implement=${onImplement}
        ></com-cursor>
        <div>
          <section class="requests">${watch(requestsList)}</section>
        </div>
        <com-tabs>
          <pre label="React">${watch(idk, "reactCode")}</pre>
          <com-markdown
            label="Spec"
            .markdown=${watch(idk, "speclang")}
          ></com-markdown>
          <pre label="Code">${watch(idk, "transformed")}</pre>
          <com-chat label="App">
            <com-thread slot="main"></com-thread>
          </com-chat>
        </com-tabs>
        <com-debug>
          <pre>${watch(stateSnapshot)}</pre>
        </com-debug>
      </main>
    `;
  }
}
