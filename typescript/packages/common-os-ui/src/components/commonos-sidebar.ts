import { LitElement, css, html } from "lit-element";
import { customElement } from "lit/decorators.js";
import { base } from "../shared/styles.js";

@customElement("commonos-sidebar")
export class CommonOsSidebar extends LitElement {
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
      <commonos-toolbar>
        <slot name="actions"></slot>
      </commonos-toolbar>
      <div>
        <slot name="content"></slot>
      </div>
    `;
  }
}

@customElement("common-sidebar-group")
export class CommonOsSidebarGroup extends LitElement {
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
