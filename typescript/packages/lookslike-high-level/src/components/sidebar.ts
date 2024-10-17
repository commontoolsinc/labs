import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { when } from "lit/directives/when.js";
import { style } from "@commontools/common-ui";
import { Charm, UI, addCharms } from "../data.js";
import { CellImpl, cell } from "@commontools/common-runner";
import { watchCell } from "../watchCell.js";

@customElement("common-debug")
class CommonDebug extends LitElement {
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
class CommonSidebar extends LitElement {
  @property({ type: Object })
  focusedCharm: CellImpl<Charm> | null = null;

  @property({ type: Object })
  focusedProxy: Charm | null = null;

  @state()
  private sidebarTab: string = "prompt";

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
    this.focusedCharm?.asSimpleCell([field]) ||
    cell(defaultValue).asSimpleCell();

  override render() {
    const prompt = this.getFieldOrDefault("prompt", "");
    const data = this.getFieldOrDefault("data", {});
    const src = this.getFieldOrDefault("partialHTML", {});
    const schema = this.getFieldOrDefault("schema", {});
    const query = this.getFieldOrDefault("query", {});

    const sidebarNav = html`
      <os-icon-button
        slot="toolbar-end"
        icon="message"
        @click=${() => {
          this.sidebarTab = "prompt";
        }}
      ></os-icon-button>
      <os-icon-button
        slot="toolbar-end"
        icon="query_stats"
        @click=${() => {
          this.sidebarTab = "query";
        }}
      ></os-icon-button>
      <os-icon-button
        slot="toolbar-end"
        icon="database"
        @click=${() => {
          this.sidebarTab = "data";
        }}
      ></os-icon-button>
      <os-icon-button
        slot="toolbar-end"
        icon="code"
        @click=${() => {
          this.sidebarTab = "source";
        }}
      ></os-icon-button>
      <os-icon-button
        slot="toolbar-end"
        icon="schema"
        @click=${() => {
          this.sidebarTab = "schema";
        }}
      ></os-icon-button>
      <os-sidebar-close-button slot="toolbar-end"></os-sidebar-close-button>
    `;

    return html`
      <os-navstack>
        ${when(
          this.sidebarTab === "query",
          () =>
            html`<os-navpanel safearea>
              ${sidebarNav}
              <os-sidebar-group>
                <div slot="label">Query</div>
                <div>
                  <common-debug
                    slot="content"
                    .content=${watchCell(query)}
                  ></common-debug>
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
                  <common-debug
                    slot="content"
                    .content=${watchCell(schema)}
                  ></common-debug>
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
                <div slot="label">Source</div>
                <div>
                  <common-debug
                    slot="content"
                    .content=${watchCell(src)}
                  ></common-debug>
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
                  <common-debug
                    slot="content"
                    .content=${watchCell(data)}
                  ></common-debug>
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
                <div slot="label">Prompt</div>
                <div>
                  <common-debug
                    slot="content"
                    .content=${watchCell(prompt)}
                  ></common-debug>
                </div>
              </os-sidebar-group>
            </os-navpanel>`,
          () => html``,
        )}
      </os-navstack>
    `;
  }
}
