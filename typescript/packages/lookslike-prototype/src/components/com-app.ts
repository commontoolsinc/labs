import { LitElement, html } from "lit-element";
import { customElement, state } from "lit/decorators.js";
import { base } from "../styles.js";
import {
  CONTENT_TYPE_DATA,
  CONTENT_TYPE_EVENT_LISTENER,
  CONTENT_TYPE_GLSL,
  CONTENT_TYPE_JAVASCRIPT,
  CONTENT_TYPE_PLACEHOLDER,
  CONTENT_TYPE_SCENE,
  CONTENT_TYPE_UI
} from "../contentType.js";
import {
  fixGraph,
  sketchReactVersion,
  transformToGraph
} from "../agent/plan.js";
import { recordThought, suggestions } from "../agent/model.js";
import { LLMClient, LlmTool } from "@commontools/llm-client";
import { LLM_SERVER_URL } from "../llm-client.js";
import { ChatCompletionTool } from "openai/resources/index.mjs";
import { computed } from "@vue/reactivity";
import { Graph } from "../reactivity/runtime.js";
import { cursor } from "../agent/cursor.js";
import { watch } from "../reactivity/watch.js";
import { grabJavascript, grabMarkdown, grabSpeclang } from "../agent/llm.js";
import { css } from "lit";
import {
  appGraph,
  appState,
  listSessions,
  loadSession,
  saveSession,
  session,
  sessionList
} from "../state.js";

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
  @state() selectedSession: string = "";

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

  async generateReactVersion() {
    cursor.state = "sketching";
    const { system, prompt } = sketchReactVersion(session.requests);

    const client = new LLMClient({
      serverUrl: LLM_SERVER_URL,
      tools: [],
      system
    });

    const res = await client.createThread(prompt);
    const last = res.conversation[res.conversation.length - 1];
    recordThought({ role: "assistant", content: last });

    session.reactCode = last;

    cursor.state = "idle";
    this.requestUpdate();
    return last;
  }

  async translateReactToGraph() {
    cursor.state = "detailing";
    const { system, prompt } = transformToGraph(session.reactCode);

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

    session.transformed = code;
    session.speclang = spec;

    this.requestUpdate();
    cursor.state = "idle";
    return last;
  }

  async generateProgram() {
    const refresh = this.requestUpdate.bind(this);

    type Id = string;
    type PortName = string;

    type Bindings = {
      inputs: [PortName]; // named arguments for this node
      outputs: { [target: Id]: PortName }; // bindings for the output of this node
    };

    const code = session.transformed;
    let errors = [] as string[];
    const allBindings = {} as { [id: Id]: Bindings };

    appGraph.clear();

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
        session.transformed,
        session.speclang,
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

      const spec = grabMarkdown(last) || grabSpeclang(last);
      const code = grabJavascript(last);

      session.transformed = code;
      session.speclang = spec;

      return false;
    }

    appGraph.update();
    this.requestUpdate();
    return true;
  }

  async planResponse(userInput: string) {
    cursor.state = "sketching";

    if (cursor.focus.length > 0) {
      userInput = `<user-selection>${cursor.focus.map((f) => f.id).join(", ")}</user-selection> ${userInput}`;
    }

    session.requests.push(userInput);

    await this.generateReactVersion();

    cursor.state = "idle";
  }

  override render() {
    const onCursorMessage = (ev: CustomEvent) => {
      this.planResponse(ev.detail.message);
    };

    const onReactChanged = (ev: CustomEvent) => {
      session.reactCode = ev.detail.code;
    };

    const onCodeChanged = (ev: CustomEvent) => {
      session.transformed = ev.detail.code;
    };

    const onGenerateGraph = async () => {
      await this.translateReactToGraph();
    };

    const onGenerateProgram = async () => {
      cursor.state = "working";
      let passedCheck = await this.generateProgram();
      cursor.state = "idle";
    };

    const onSaveSession = async () => {
      if (this.selectedSession.length === 0) {
        const name = prompt("Name the session");
        if (!name) return;

        this.selectedSession = name;
      }

      await saveSession(this.selectedSession);
    };

    const onLoadSession = async () => {
      if (this.selectedSession.length > 0) {
        await loadSession(this.selectedSession);
        this.requestUpdate();
      }
    };

    const onSelectSavedSession = async (event: CustomEvent) => {
      this.selectedSession = event.target?.value;
    };

    const onClearSession = async () => {
      if (confirm("Clear session?")) {
        session.requests = [];
        session.transformed = "";
        session.reactCode = "";
        session.history = [];
        session.speclang = "";
        this.selectedSession = "";
        this.requestUpdate();
      }
    };

    return html`
      <main>
        <button @click=${onClearSession}>Clear</button>
        <select @change=${onSelectSavedSession} .value=${this.selectedSession}>
          <option value="">-- New --</option>
          ${watch(
            computed(() => {
              return sessionList.recipes.map(
                (s) => html`<option value=${s}>${s}</option>`
              );
            })
          )}
        </select>
        <button @click=${onLoadSession}>Load</button>
        <button @click=${onSaveSession}>Save</button>
        <com-cursor
          .suggestions=${watch(suggestions)}
          @message=${onCursorMessage}
        ></com-cursor>
        <div>
          <section class="requests">${watch(requestsList)}</section>
        </div>
        <com-tabs>
          <div label="React">
            <button @click=${onGenerateGraph}>Re-generate Graph</button>
            <com-code
              .code=${watch(session, "reactCode")}
              @updated=${onReactChanged}
            ></com-code>
          </div>
          <div label="Explanation">
            <com-markdown
              .markdown=${watch(session, "speclang")}
            ></com-markdown>
          </div>
          <div label="Graph">
            <button @click=${onGenerateProgram}>Re-generate Program</button>
            <com-code
              .code=${watch(session, "transformed")}
              @updated=${onCodeChanged}
            ></com-code>
          </div>
          <com-chat label="Program">
            <com-thread slot="main"></com-thread>
          </com-chat>
          <div label="View">
            <com-recipe></com-recipe>
          </div>
        </com-tabs>
        <com-debug>
          <pre>${watch(stateSnapshot)}</pre>
        </com-debug>
      </main>
    `;
  }
}
