import { LitElement, css, html } from "lit-element";
import { customElement } from "lit/decorators.js";
import { base } from "../shared/styles.js";

@customElement("os-sidebar")
export class OsSidebar extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        display: block;
      }

      .sidebar {
        display: grid;
        grid-template-columns: 1fr;
        grid-template-rows: auto 1fr;
        grid-template-areas:
          "toolbar"
          "content";
        height: 100%;
      }

      .sidebar-toolbar {
        grid-area: toolbar;
      }

      .sidebar-content {
        grid-area: content;
        padding: var(--u-pad);
        overflow-x: hidden;
        overflow-y: auto;
      }
    `,
  ];

  override render() {
    return html`
      <aside class="sidebar">
        <os-toolbar class="sidebar-toolbar">
          <slot slot="end" name="actions"></slot>
        </os-toolbar>
        <div class="sidebar-content">
          <slot name="content"></slot>
        </div>
      </aside>
    `;
  }
}

@customElement("os-sidebar-group")
export class OsSidebarGroup extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        display: flex;
        flex-direction: column;
      }
    `,
  ];

  override render() {
    return html`
      <aside class="vstack">
        <div class="label"><slot name="label"></slot></div>
        <div><slot name="content"></slot></div>
      </aside>
    `;
  }
}
