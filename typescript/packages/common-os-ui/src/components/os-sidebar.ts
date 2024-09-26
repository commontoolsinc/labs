import { LitElement, css, html } from "lit-element";
import { customElement } from "lit/decorators.js";
import { base } from "../shared/styles.js";

@customElement("os-sidebar")
export class OsSidebar extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        display: flex;
        flex-direction: column;
        padding: var(--u-pad);
      }
    `,
  ];

  override render() {
    return html`
      <os-toolbar>
        <slot slot="end" name="actions"></slot>
      </os-toolbar>
      <div>
        <slot name="content"></slot>
      </div>
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
