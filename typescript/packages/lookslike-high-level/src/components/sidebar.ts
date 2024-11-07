import { LitElement, html, css, PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import { when } from "lit/directives/when.js";
import { style } from "@commontools/common-ui";
import { Charm, charms, recipes, UI, runPersistent, TYPE, addCharms } from "../data.js";
import { CellImpl, addRecipe, cell, getRecipeSrc, run } from "@commontools/common-runner";
import { buildRecipe } from "../localBuild.js";
import { watchCell } from "../watchCell.js";
import { createRef, ref } from "lit/directives/ref.js";
import { home } from "../recipes/home.js";
import { render } from "@commontools/common-html";

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

  homeRef = createRef<HTMLElement>();
  homeCharm: Promise<CellImpl<Charm>> | null = null;

  static override styles = [
    style.baseStyles,
    css`
      :host {
        display: block;
        height: 100%;
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
  }

  override render() {
    const prompt = this.getFieldOrDefault("prompt", "");
    const data = this.getFieldOrDefault("data", {});
    const recipeId = this.focusedCharm?.sourceCell?.get()?.[TYPE];
    const src = getRecipeSrc(recipeId);
    const schema = this.getFieldOrDefault("schema", {});
    const query = this.getFieldOrDefault("query", {});

    const sidebarNav = html`
      <os-icon-button
        slot="toolbar-end"
        icon="home"
        @click=${() => this.handleSidebarTabChange("home")}
      ></os-icon-button>
      <os-icon-button
        slot="toolbar-end"
        icon="message"
        @click=${() => this.handleSidebarTabChange("prompt")}
      ></os-icon-button>
      <os-icon-button
        slot="toolbar-end"
        icon="query_stats"
        @click=${() => this.handleSidebarTabChange("query")}
      ></os-icon-button>
      <os-icon-button
        slot="toolbar-end"
        icon="database"
        @click=${() => this.handleSidebarTabChange("data")}
      ></os-icon-button>
      <os-icon-button
        slot="toolbar-end"
        icon="code"
        @click=${() => this.handleSidebarTabChange("source")}
      ></os-icon-button>
      <os-icon-button
        slot="toolbar-end"
        icon="schema"
        @click=${() => this.handleSidebarTabChange("schema")}
      ></os-icon-button>
      <os-sidebar-close-button slot="toolbar-end"></os-sidebar-close-button>
    `;

    const onSpecChanged = (e: CustomEvent) => {
      this.setField("prompt", e.detail.state.doc.toString());
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

    const compile = () => {
      console.log("compile", this.workingSrc);
      const { recipe, errors } = buildRecipe(this.workingSrc);
      console.log("recipe", recipe);
      console.log("errors", errors);
      this.compileErrors = errors || "";

      if (!recipe) return;
      addRecipe(recipe, this.workingSrc);

      // TODO(ja): we should check if the recipe parameters have changed
      const charm = run(recipe, this.focusedCharm?.sourceCell?.get().parameters);

      console.log("charm", charm);
      addCharms([charm]);
      const charmId = JSON.stringify(charm.entityId);
      console.log("open-charm", { charmId });
      this.dispatchEvent(
        new CustomEvent("open-charm", {
          detail: { charmId },
          bubbles: true,
          composed: true,
        })
      );
    }

    const copyRecipeLink = (event: Event) => {
      const target = event.target as HTMLAnchorElement;
      navigator.clipboard.writeText(target.href);
      event.preventDefault();
      const toast = document.createElement('div');
      toast.textContent = 'Copied link to clipboard!';
      toast.style.cssText = `
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
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 3000);
    }

    return html`
      <os-navstack>
        ${when(
      this.sidebarTab === "home",
      () =>
        html`<os-navpanel safearea>
              ${sidebarNav}
              <os-sidebar-group>
                <div slot="label">Pinned</div>
                <div ${ref(this.homeRef)}></div>
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
                    .source=${watchCell(schema, (q) =>
          JSON.stringify(q, null, 2),
        )}
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
                <div slot="label">Source
                
                <a href="/recipe/${recipeId}" 
                    target="_blank" 
                    @click=${copyRecipeLink}
                    style="float: right">🔗 Share</a></div>
                <div>
                  <button @click=${compile}>🔄 Compile + Run</button>
                  <os-code-editor
                    slot="content"
                    language="text/x.typescript"
                    .source=${src}
                    @doc-change=${onSrcChanged}
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
                <div slot="label">Spec
                  <a href="/recipe/${recipeId}" 
                    target="_blank" 
                    @click=${copyRecipeLink}
                    style="float: right">🔗 Share</a>
</div>
                <div>
                  <os-code-editor
                    slot="content"
                    language="text/markdown"
                    .source=${watchCell(prompt)}
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
