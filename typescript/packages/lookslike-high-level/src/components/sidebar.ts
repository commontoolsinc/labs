import { LitElement, html, css, PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import { when } from "lit/directives/when.js";
import { style } from "@commontools/common-ui";
import { Charm, charms, recipes, UI, runPersistent } from "../data.js";
import { CellImpl, cell } from "@commontools/common-runner";
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
    _changedProperties: PropertyValues
  ): Promise<void> {
    super.updated(_changedProperties);

    if (_changedProperties.has('sidebarTab') && this.homeCharm) {
      this.homeCharm = null;
    }

    if (!this.homeCharm && this.homeRef.value) {
      this.homeCharm = runPersistent(home, { charms, recipes }, "home").then(
        (home) => {
          const view = home.asRendererCell<Charm>().key(UI).get();
          if (!view) throw new Error("Charm has no UI");
          render(this.homeRef.value!, view);
          return home;
        }
      );
    }
  }

  override render() {
    const prompt = this.getFieldOrDefault("prompt", "");
    const data = this.getFieldOrDefault("data", {});
    const src = this.getFieldOrDefault("partialHTML", "");
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
          () => html``
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
                      JSON.stringify(q, null, 2)
                    )}
                    @doc-change=${onQueryChanged}
                  ></os-code-editor>
                </div>
              </os-sidebar-group>
            </os-navpanel>`,
          () => html``
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
                      JSON.stringify(q, null, 2)
                    )}
                  ></os-code-editor>
                </div>
              </os-sidebar-group>
            </os-navpanel>`,
          () => html``
        )}
        ${when(
          this.sidebarTab === "source",
          () =>
            html`<os-navpanel safearea>
              ${sidebarNav}
              <os-sidebar-group>
                <div slot="label">Source</div>
                <div>
                  <os-code-editor
                    slot="content"
                    language="text/html"
                    .source=${watchCell(src)}
                  ></os-code-editor>
                </div>
              </os-sidebar-group>
            </os-navpanel>`,
          () => html``
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
                      JSON.stringify(q, null, 2)
                    )}
                  ></os-code-editor>
                </div>
              </os-sidebar-group>
            </os-navpanel>`,
          () => html``
        )}
        ${when(
          this.sidebarTab === "prompt",
          () =>
            html`<os-navpanel safearea>
              ${sidebarNav}
              <os-sidebar-group>
                <div slot="label">Spec</div>
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
          () => html``
        )}
      </os-navstack>
    `;
  }
}
