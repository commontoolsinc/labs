import { css, html, LitElement, PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import { when } from "lit/directives/when.js";
import { style } from "@commontools/common-ui";
import {
  addCharms,
  Charm,
  charms,
  NAME,
  recipes,
  runPersistent,
  TYPE,
  UI,
} from "../data.js";
import {
  addRecipe,
  cell,
  CellImpl,
  getRecipe,
  getRecipeSrc,
  isCell,
  run,
  getRecipeSpec,
} from "@commontools/common-runner";
import { buildRecipe } from "../localBuild.js";
import { watchCell } from "../watchCell.js";
import { createRef, ref } from "lit/directives/ref.js";
import { home } from "../recipes/home.js";
import { render } from "@commontools/common-html";
import { LLMClient } from "@commontools/llm-client";

const toasty = (message: string) => {
  const toastEl = document.createElement("div");
  toastEl.textContent = message;
  toastEl.style.cssText = `
    position: fixed;
    top: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: #333;
    color: white;
    padding: 8px 16px;
    border-radius: 4px;
    z-index: 1000;
  `;
  document.body.appendChild(toastEl);
  setTimeout(() => toastEl.remove(), 3000);
};

@customElement("common-debug")
export class CommonDebug extends LitElement {
  @property({ type: Object })
  content: any;

  static override styles = css`
    pre {
      white-space: pre-wrap;
      word-break: break-word;
    }
  `;

  override render() {
    return html`
      <pre slot="content">
${typeof this.content === "string"
          ? this.content
          : JSON.stringify(this.content, null, 2)}</pre
      >
    `;
  }
}

interface LLMConversation {
  model: string;
  system: string;
  messages: string[];
}

interface LLMEvalFeedback {
  score: number;
  feedback: string;
  conversation: LLMConversation;
}

@customElement("common-sidebar")
export class CommonSidebar extends LitElement {
  @property({ type: Object })
  focusedCharm: CellImpl<Charm> | null = null;

  @property({ type: Object })
  focusedProxy: Charm | null = null;

  @property({ type: String })
  sidebarTab: string = "home";

  @property({ type: String })
  compileErrors: string = "";

  @property({ type: String })
  workingSrc: string = "";

  @property({ type: String })
  workingSpec: string = "";

  @property({ type: Object })
  llmConversation: LLMConversation | null = null;

  private homeRef = createRef<HTMLElement>();
  private editorRef = createRef<HTMLElement>();
  private homeCharm: Promise<CellImpl<Charm>> | null = null;
  private linkedCharms: CellImpl<Charm>[] = [];

  static override styles = [
    style.baseStyles,
    css`
      :host {
        display: block;
        height: 100%;
      }

      .nav-buttons {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        padding: 4px;
        text-align: justify;
        text-justify: distribute;
      }

      os-icon-button,
      os-sidebar-close-button {
        scale: 0.9;
        width: 40px;
        flex: 0 0 auto;
      }
    `,
  ];

  private getFieldOrDefault = <T>(field: string, defaultValue: T) =>
    this.focusedCharm?.asRendererCell([field]) ||
    cell(defaultValue).asRendererCell();

  private setField = <T>(field: string, value: T) => {
    this.focusedCharm?.asRendererCell([field]).send(value);
  };

  private handleSidebarTabChange(tabName: string) {
    const event = new CustomEvent("tab-changed", {
      detail: { tab: tabName },
      bubbles: true,
      composed: true,
    });
    this.dispatchEvent(event);
  }

  protected override async updated(
    _changedProperties: PropertyValues,
  ): Promise<void> {
    super.updated(_changedProperties);

    if (_changedProperties.has("sidebarTab") && this.homeCharm) {
      this.homeCharm = null;
    }

    if (!this.homeCharm && this.homeRef.value) {
      this.homeCharm = runPersistent(home, { charms, recipes }, "home").then(
        (home) => {
          const view = home.asRendererCell<Charm>().key(UI);
          if (!view.getAsQueryResult()) throw new Error("Charm has no UI");
          render(this.homeRef.value!, view);
          return home;
        },
      );
    }

    if (_changedProperties.has("focusedCharm")) {
      const processCell = this.focusedCharm?.sourceCell?.get();
      if (processCell) {
        const linkedCharms = new Set<CellImpl<Charm>>();
        const traverse = (value: any, parents: any[] = []) => {
          if (isCell(value)) {
            const initialCell = value;

            while (value.sourceCell) value = value.sourceCell;
            if (value.get()?.resultRef) value = value.get().resultRef.cell;

            if (value !== this.focusedCharm) {
              if (value.get()?.[NAME] && value.get()?.[UI]) {
                linkedCharms.add(value);
              } else {
                console.log("not a charm", initialCell, value.get(), parents);
              }
            }
          } else if (typeof value === "object" && value !== null) {
            for (const key in value) {
              traverse(value[key], [...parents, value]);
            }
          }
        };
        traverse(processCell);
        this.linkedCharms = Array.from(linkedCharms);
      }
    }
  }

  override render() {
    const data = this.getFieldOrDefault("data", {});
    const recipeId = this.focusedCharm?.sourceCell?.get()?.[TYPE];
    const recipe = getRecipe(recipeId);
    const spec = getRecipeSpec(recipeId);
    const src = getRecipeSrc(recipeId);
    const schema = recipe?.argumentSchema || {};
    const query = this.getFieldOrDefault("query", {});

    const sidebarNav = html`<div class="nav-buttons" slot="toolbar-start">
        <os-icon-button
          icon="home"
          @click=${() => this.handleSidebarTabChange("home")}
        ></os-icon-button>
        <os-icon-button
          icon="message"
          @click=${() => this.handleSidebarTabChange("prompt")}
        ></os-icon-button>
        <os-icon-button
          icon="sync_alt"
          @click=${() => this.handleSidebarTabChange("links")}
        ></os-icon-button>
        <os-icon-button
          icon="query_stats"
          @click=${() => this.handleSidebarTabChange("query")}
        ></os-icon-button>
        <os-icon-button
          icon="database"
          @click=${() => this.handleSidebarTabChange("data")}
        ></os-icon-button>
        <os-icon-button
          icon="schema"
          @click=${() => this.handleSidebarTabChange("schema")}
        ></os-icon-button>
        <os-icon-button
          icon="code"
          @click=${() => this.handleSidebarTabChange("source")}
        ></os-icon-button>
        <os-icon-button
          icon="data_object"
          @click=${() => this.handleSidebarTabChange("recipe-json")}
        ></os-icon-button>
      </div>
      <os-sidebar-close-button slot="toolbar-end"></os-sidebar-close-button> `;

    const onSpecChanged = (e: CustomEvent) => {
      this.workingSpec = e.detail.state.doc.toString();
    };

    const onQueryChanged = (e: CustomEvent) => {
      this.setField("query", JSON.parse(e.detail.state.doc.toString()));
    };

    const onDataChanged = (e: CustomEvent) => {
      this.setField("data", JSON.parse(e.detail.state.doc.toString()));
    };

    const onSrcChanged = (e: CustomEvent) => {
      this.workingSrc = e.detail.state.doc.toString();
    };

    // FIXME(jake): this should only be called when src changes, not on every render.
    if (this.workingSrc) {
      buildRecipe(this.workingSrc).then(({ errors }) => {
        this.compileErrors = errors || "";
      });
    }

    // NOTE(jake): maybe rename this to "compileAndSave" or something?
    const runRecipe = (newData: boolean = false) => {
      buildRecipe(this.workingSrc).then(({ recipe, errors }) => {
        this.compileErrors = errors || "";

        if (!recipe) return;
        // NOTE(ja): adding a recipe triggers saving to blobby
        addRecipe(recipe, this.workingSrc, this.workingSpec);

        // TODO(ja): we should check if the recipe arguments have changed
        // TODO(ja): if default values have changed and source still has to old
        //           defaults, update to new defaults
        const data = newData
          ? {}
          : this.focusedCharm?.sourceCell?.get()?.argument;
        const charm = run(recipe, data);

        addCharms([charm]);
        const charmId = JSON.stringify(charm.entityId);
        this.dispatchEvent(
          new CustomEvent("open-charm", {
            detail: { charmId },
            bubbles: true,
            composed: true,
          }),
        );
        if (newData) {
          toasty("Welcome to a new charm!");
        } else {
          toasty("Welcome to a new version of this charm!");
        }
      });
    };

    const handleEvalFeedback = (
      score: number,
      {
        feedback,
        compileErrors,
      }: { feedback?: string; compileErrors?: string },
    ) => {
      const evalFeedback = {
        score: score,
        conversation: this.llmConversation,
        feedback,
        compileErrors,
      };

      if (score === 1) {
        console.log("👍 - yay - sending llm feedback to some server");
      } else {
        console.log("👎 - boo - sending llm feedback to some server");
      }

      console.log("evalFeedback", evalFeedback);
      // TODO(jake): send conversation and score to llm for evals
    };

    // FIXME(jake): implement "fix this" button after this works
    const askLLM = async ({ fixit }: { fixit?: string } = {}) => {
      const originalSrc = src;
      const originalSpec =
        spec ||
        "there is no spec, describe the app in a descriptive and delcarative way";
      const newSpec = this.workingSpec;
      const prefill = `\`\`\`tsx\n`; // fixme - put the imports from originalSrc?
      const url =
        typeof window !== "undefined"
          ? window.location.protocol + "//" + window.location.host + "/api/llm"
          : "//api/llm";

      const messages = [
        originalSpec,
        `\`\`\`tsx\n${originalSrc}\n\`\`\``,
        newSpec,
        prefill,
      ];

      if (fixit) {
        console.log("fixit", fixit);
        const fixitPrompt = `The user asked you to fix the following:
\`\`\`
${fixit}
\`\`\`

Here is the current source code:
\`\`\`tsx
${this.workingSrc}
\`\`\`

RESPOND WITH THE FULL SOURCE CODE - DO NOT INCLUDE ANY OTHER TEXT.
`;
        messages.push(fixitPrompt);
      }

      const llm = new LLMClient(url);

      const payload = {
        model: "anthropic:claude-3-5-sonnet-latest",
        system:
          "You are a helpful assistant that can help me improve my recipe.",
        messages,
      };

      // If this is the first round of the llm conversation, set the payload on the llmConversation property.
      if (!this.llmConversation) {
        this.llmConversation = payload;
      } else {
        // otherwise, append the new message to the messages array
        this.llmConversation.messages.push(...payload.messages);
      }

      const response = await llm.sendRequest(
        payload,
        // (text) => (text) => console.log(text),
      );

      console.log("full response", response);
      const newSrc = response.match(/```tsx\n([\s\S]+?)```/)?.[1];
      if (!newSrc) {
        console.error("No tsx found in text", response);
        return;
      }
      // tell the editor this is the new source
      if (this.editorRef.value) {
        this.editorRef.value.source = newSrc;
      }
    };

    const exportData = () => {
      const data = this.focusedCharm?.sourceCell?.getAsQueryResult()?.argument;
      if (!data) return;
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "arguments.json";
      a.click();
    };

    const copyRecipeLink = (event: Event) => {
      const target = event.target as HTMLAnchorElement;
      navigator.clipboard.writeText(target.href);
      event.preventDefault();
      toasty("Copied recipe link to clipboard");
    };

    return html`
      <os-navstack>
        ${when(
          this.sidebarTab === "home",
          () =>
            html`<os-navpanel safearea>
              ${sidebarNav}
              <os-sidebar-group safearea>
                <div slot="label">Pinned</div>
                <div ${ref(this.homeRef)}></div>
              </os-sidebar-group>
            </os-navpanel>`,
          () => html``,
        )}
        ${when(
          this.sidebarTab === "links",
          () =>
            html`<os-navpanel safearea>
              ${sidebarNav}
              <os-sidebar-group>
                <div slot="label">Linked Charms</div>
                <div>
                  ${this.linkedCharms.map(
                    (charm) => html`
                      <common-charm-link .charm=${charm}></common-charm-link>
                    `,
                  )}
                </div>
              </os-sidebar-group>
            </os-navpanel>`,
          () => html``,
        )}
        ${when(
          this.sidebarTab === "query",
          () =>
            html`<os-navpanel safearea>
              ${sidebarNav}
              <os-sidebar-group>
                <div slot="label">Query</div>
                <div>
                  <os-code-editor
                    slot="content"
                    language="application/json"
                    .source=${watchCell(query, (q) =>
                      JSON.stringify(q, null, 2),
                    )}
                    @doc-change=${onQueryChanged}
                  ></os-code-editor>
                </div>
              </os-sidebar-group>
            </os-navpanel>`,
          () => html``,
        )}
        ${when(
          this.sidebarTab === "schema",
          () =>
            html`<os-navpanel safearea>
              ${sidebarNav}
              <os-sidebar-group>
                <div slot="label">Schema</div>
                <div>
                  <os-code-editor
                    slot="content"
                    language="application/json"
                    .source=${JSON.stringify(schema, null, 2)}
                  ></os-code-editor>
                </div>
              </os-sidebar-group>
            </os-navpanel>`,
          () => html``,
        )}
        ${when(
          this.sidebarTab === "source",
          () =>
            html`<os-navpanel safearea>
              ${sidebarNav}
              <os-sidebar-group>
                <div slot="label">
                  <div
                    style="display: flex; justify-content: space-between; border: 1px solid pink; padding: 10px;"
                  >
                    <a
                      href="/recipe/${recipeId}"
                      target="_blank"
                      @click=${copyRecipeLink}
                      style="float: right"
                      >🔗 Share</a
                    >
                    <a
                      href="https://paas.saga-castor.ts.net/blobby/blob/${recipeId}"
                      target="_blank"
                    >
                      🪄 Spellbook jr</a
                    >
                    <a
                      href="https://paas.saga-castor.ts.net/blobby/blob/${recipeId}/png"
                      target="_blank"
                    >
                      📸 Spellbook screenshot</a
                    >
                  </div>
                </div>
                <div style="margin: 10px;">
                  <button @click=${() => runRecipe(false)}>
                    🔄 Run w/Current Data
                  </button>
                  <button @click=${() => runRecipe(true)}>
                    🐣 Run w/New Data
                  </button>
                  <button @click=${() => exportData()}>
                    📄 Export Arguments
                  </button>
                  <button @click=${() => askLLM()}>🤖 LLM</button>
                  <button @click=${() => askLLM({ fixit: this.compileErrors })}>
                    🪓 fix it
                  </button>
                  <button
                    @click=${() =>
                      handleEvalFeedback(1, {
                        compileErrors: this.compileErrors,
                      })}
                  >
                    👍 +1
                  </button>
                  <button
                    @click=${() =>
                      handleEvalFeedback(0, {
                        compileErrors: this.compileErrors,
                      })}
                  >
                    👎 -1
                  </button>

                  ${when(
                    this.compileErrors,
                    () =>
                      html`<pre
                        style="color: white; background: #800; padding: 4px"
                      >
${this.compileErrors}</pre
                      >`,
                    () => html``,
                  )}

                  <div>
                    <span
                      style="padding-left: 25px; color: #969696; font-size: 12px;"
                      >SPEC</span
                    >
                    <os-code-editor
                      slot="content"
                      language="text/markdown"
                      .source=${spec}
                      @doc-change=${onSpecChanged}
                    ></os-code-editor>
                  </div>
                </div>

                <div>
                  <span
                    style="padding-left: 25px; color: #969696; font-size: 12px;"
                    >SOURCE</span
                  >

                  <os-code-editor
                    slot="content"
                    language="text/x.typescript"
                    .source=${src}
                    @doc-change=${onSrcChanged}
                    ${ref(this.editorRef)}
                  ></os-code-editor>
                </div>
              </os-sidebar-group>
            </os-navpanel>`,
          () => html``,
        )}
        ${when(
          this.sidebarTab === "recipe-json",
          () =>
            html`<os-navpanel safearea>
              ${sidebarNav}
              <os-sidebar-group>
                <div slot="label">Recipe JSON</div>
                <div>
                  <os-code-editor
                    slot="content"
                    language="application/json"
                    .source=${JSON.stringify(getRecipe(recipeId), null, 2)}
                  ></os-code-editor>
                </div>
              </os-sidebar-group>
            </os-navpanel>`,
          () => html``,
        )}
        ${when(
          this.sidebarTab === "data",
          () =>
            html`<os-navpanel safearea>
              ${sidebarNav}
              <os-sidebar-group>
                <div slot="label">Data</div>
                <div>
                  <os-code-editor
                    slot="content"
                    language="application/json"
                    .source=${watchCell(data, (q) =>
                      JSON.stringify(q, null, 2),
                    )}
                    @doc-change=${onDataChanged}
                  ></os-code-editor>
                </div>
              </os-sidebar-group>
            </os-navpanel>`,
          () => html``,
        )}
        ${when(
          this.sidebarTab === "prompt",
          () =>
            html`<os-navpanel safearea>
              ${sidebarNav}
              <os-sidebar-group>
                <div slot="label">
                  Spec
                  <a
                    href="/recipe/${recipeId}"
                    target="_blank"
                    @click=${copyRecipeLink}
                    style="float: right"
                    >🔗 Share</a
                  >
                </div>
                <div>
                  <os-code-editor
                    slot="content"
                    language="text/markdown"
                    .source=${spec}
                    @doc-change=${onSpecChanged}
                  ></os-code-editor>
                </div>
              </os-sidebar-group>
            </os-navpanel>`,
          () => html``,
        )}
      </os-navstack>
    `;
  }
}
