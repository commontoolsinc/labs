import { css, html, LitElement, PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import { style } from "@commontools/ui";
import { Charm, charms, NAME, recipes, runPersistent, TYPE, UI } from "../data.js";
import {
  getDoc,
  DocImpl,
  getRecipe,
  isDoc,
  getRecipeParents,
  getRecipeSpec,
  getRecipeSrc,
} from "@commontools/runner";
import { watchCell } from "../watchCell.js";
import { createRef, ref } from "lit/directives/ref.js";
import { home } from "../recipes/home.jsx";
import { render } from "@commontools/html";
import { saveRecipe } from "../data.js";

// bf: TODO, send a "toast" event on window and an use another element to handle it
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
${typeof this.content === "string" ? this.content : JSON.stringify(this.content, null, 2)}</pre
      >
    `;
  }
}

@customElement("common-sidebar")
export class CommonSidebar extends LitElement {
  @property({ type: Object })
  focusedCharm: DocImpl<Charm> | null = null;

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
  private homeRef = createRef<HTMLElement>();
  private homeCharm: Promise<DocImpl<Charm>> | null = null;
  private linkedCharms: DocImpl<Charm>[] = [];

  static override styles = [
    style.baseStyles,
    css`
      :host {
        display: block;
        height: 100%;
        display: flex;
        flex-direction: column;
      }

      os-navstack {
        flex: 1;
        min-height: 0;
      }

      .panel-container {
        position: relative;
        height: 100%;
        overflow: hidden;
      }

      os-navpanel {
        position: absolute;
        width: 100%;
        height: 100%;
        transition:
          transform 0.1s ease,
          opacity 0.1s ease;
        opacity: 0;
        transform: translateX(15px);
        pointer-events: none;
      }

      os-navpanel.active {
        opacity: 1;
        transform: translateX(0);
        pointer-events: auto;
      }

      os-navpanel.exit {
        opacity: 0;
        transform: translateX(-15px);
      }

      .close-button {
        transition: none;
      }

      .sidebar-content {
        padding: var(--gap-xsm);
        padding-bottom: 0;
        box-sizing: border-box;
      }
    `,
  ];

  private getFieldOrDefault = <T>(field: string, defaultValue: T) =>
    this.focusedCharm?.asCell([field]) || getDoc(defaultValue).asCell();

  private setField = <T>(field: string, value: T) => {
    this.focusedCharm?.asCell([field]).send(value);
  };

  private handleSidebarTabChange(tabName: string) {
    const currentPanel = this.shadowRoot?.querySelector(".active");
    if (currentPanel) {
      currentPanel.classList.add("exit");
      setTimeout(() => {
        currentPanel.classList.remove("exit");
        this.sidebarTab = tabName;
      }, 100); // Match transition duration
    } else {
      this.sidebarTab = tabName;
    }

    const event = new CustomEvent("tab-changed", {
      detail: { tab: tabName },
      bubbles: true,
      composed: true,
    });
    this.dispatchEvent(event);
  }

  private async handlePublish() {
    const input = prompt("Enter title and #tags for your spell:");
    if (!input) return;

    const tags = (input.match(/#[\w-]+/g) || []).map((tag) => tag.slice(1));
    const title = input.replace(/#[\w-]+/g, "").trim();

    const recipeId = this.focusedCharm?.sourceCell?.get()?.[TYPE];
    const src = getRecipeSrc(recipeId) || "";
    const spec = getRecipeSpec(recipeId);
    const parents = getRecipeParents(recipeId);

    const success = await saveRecipe(recipeId, src, spec, parents, title, tags);

    if (success) {
      window.focus();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const spellbookUrl = `https://paas.saga-castor.ts.net/spellbookjr/recipes/spell-${recipeId}`;
      try {
        await navigator.clipboard.writeText(spellbookUrl);
        toasty("Published to Spellbook Jr! Spellbook link copied to clipboard");
      } catch (err) {
        toasty(`Published to Spellbook Jr! Spellbook URL: ${spellbookUrl}`);
        console.error("Failed to copy to clipboard:", err);
      }
    } else {
      toasty("Failed to publish");
    }
  }

  protected override async updated(_changedProperties: PropertyValues): Promise<void> {
    super.updated(_changedProperties);

    if (_changedProperties.has("sidebarTab") && this.homeCharm) {
      this.homeCharm = null;
    }

    if (!this.homeCharm && this.homeRef.value) {
      this.homeCharm = runPersistent(home, { charms, recipes }, "home").then((home) => {
        const view = home.asCell<Charm>().key(UI);
        if (!view.getAsQueryResult()) throw new Error("Charm has no UI");
        render(this.homeRef.value!, view);
        return home;
      });
    }

    if (_changedProperties.has("focusedCharm")) {
      const processCell = this.focusedCharm?.sourceCell?.get();
      if (processCell) {
        const linkedCharms = new Set<DocImpl<Charm>>();
        const traverse = (value: any, parents: any[] = []) => {
          if (isDoc(value)) {
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

  private renderPanel(id: string, content: unknown) {
    return html`
      <os-navpanel class=${this.sidebarTab === id ? "active sidebar-content" : "sidebar-content"}>
        <common-hstack slot="toolbar-end" gap="sm">
          <os-icon-button icon="publish" @click=${() => this.handlePublish()}></os-icon-button>
          <os-sidebar-close-button></os-sidebar-close-button>
        </common-hstack>
        <os-sidebar-group> ${content} </os-sidebar-group>
      </os-navpanel>
    `;
  }

  override render() {
    const data = this.getFieldOrDefault("data", {});
    const recipeId = this.focusedCharm?.sourceCell?.get()?.[TYPE];
    const argument = this.focusedCharm?.sourceCell?.getAsQueryResult()?.argument;
    const recipe = getRecipe(recipeId);
    const schema = recipe?.argumentSchema || {};
    const query = this.getFieldOrDefault("query", {});

    const onSpecChanged = (e: CustomEvent) => {
      this.workingSpec = e.detail.state.doc.toString();
    };

    const onQueryChanged = (e: CustomEvent) => {
      this.setField("query", JSON.parse(e.detail.state.doc.toString()));
    };

    const onDataChanged = (e: CustomEvent) => {
      this.setField("data", JSON.parse(e.detail.state.doc.toString()));
    };

    const copyRecipeLink = (event: Event) => {
      const target = event.target as HTMLAnchorElement;
      navigator.clipboard.writeText(target.href);
      event.preventDefault();
      toasty("Copied recipe link to clipboard");
    };

    const tabs = [
      { id: "home", icon: "home", label: "Home" },
      { id: "prompt", icon: "message", label: "Prompt" },
      { id: "links", icon: "sync_alt", label: "Links" },
      { id: "query", icon: "query_stats", label: "Query" },
      { id: "data", icon: "database", label: "Data" },
      { id: "schema", icon: "schema", label: "Schema" },
      { id: "source", icon: "code", label: "Source" },
      { id: "recipe-json", icon: "data_object", label: "JSON" },
    ];

    const panels = {
      home: html`
        <div slot="label">Pinned</div>
        <div ${ref(this.homeRef)}></div>
      `,
      links: html`
        <div slot="label">Linked Charms</div>
        <div>
          ${this.linkedCharms.map(
            (charm) => html`<common-charm-link .charm=${charm}></common-charm-link>`,
          )}
        </div>
      `,
      query: html`
        <div slot="label">Query</div>
        <div>
          <os-code-editor
            slot="content"
            language="application/json"
            .source=${watchCell(query, (q) => JSON.stringify(q, null, 2))}
            @doc-change=${onQueryChanged}
          ></os-code-editor>
        </div>
      `,
      schema: html`
        <div slot="label">Schema</div>
        <div>
          <os-code-editor
            slot="content"
            language="application/json"
            .source=${JSON.stringify(schema, null, 2)}
          ></os-code-editor>
        </div>
      `,
      source: html`
        <div slot="label">
          <div
            style="display: flex; justify-content: space-between; border: 1px solid pink; padding: 10px;"
          >
            <a
              href="/recipe/spell-${recipeId}"
              target="_blank"
              @click=${copyRecipeLink}
              style="float: right"
              class="close-button"
              >🔗 Share</a
            >
            <button @click=${() => this.handlePublish()} class="close-button">
              🪄 Publish to Spellbook Jr
            </button>
          </div>
        </div>
        <div style="margin: 10px;"></div>
        <div>
          <common-spell-editor .recipeId=${recipeId} .data=${argument}></common-spell-editor>
        </div>
      `,
      "recipe-json": html`
        <div slot="label">Recipe JSON</div>
        <div>
          <os-code-editor
            slot="content"
            language="application/json"
            .source=${JSON.stringify(getRecipe(recipeId), null, 2)}
          ></os-code-editor>
        </div>
      `,
      data: html`
        <div slot="label">
          Data<span
            id="log-button"
            @click=${() => console.log(JSON.stringify(this.focusedCharm?.getAsQueryResult()))}
            class="close-button"
            >log</span
          >
        </div>
        <div>
          <os-code-editor
            slot="content"
            language="application/json"
            .source=${watchCell(data, (q) => JSON.stringify(q, null, 2))}
            @doc-change=${onDataChanged}
          ></os-code-editor>
        </div>
      `,
      prompt: html`
        <div slot="label">
          Spec
          <a
            href="/recipe/${recipeId}"
            target="_blank"
            @click=${copyRecipeLink}
            style="float: right"
            class="close-button"
            >🔗 Share</a
          >
        </div>
        <div>
          <os-code-editor
            slot="content"
            language="text/markdown"
            .source=${this.workingSpec}
            @doc-change=${onSpecChanged}
          ></os-code-editor>
        </div>
      `,
    };

    return html`
      <os-navstack>
        <div class="panel-container">
          ${Object.entries(panels).map(([id, content]) => this.renderPanel(id, content))}
        </div>
      </os-navstack>
      <os-tab-bar
        .items=${tabs}
        .selected=${this.sidebarTab}
        @tab-change=${(e: CustomEvent) => this.handleSidebarTabChange(e.detail.selected)}
      ></os-tab-bar>
    `;
  }
}
