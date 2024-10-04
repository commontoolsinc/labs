import { LitElement, css, html } from "lit-element";
import { customElement } from "lit/decorators.js";
import { base } from "../shared/styles.js";

@customElement("os-sidebar-group")
export class OsSidebarGroup extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        display: flex;
        flex-direction: column;
      }

      .sgroup {
        gap: var(--u);
      }
    `,
  ];

  override render() {
    return html`
      <aside class="sgroup vstack pad-h">
        <heading class="sgroup-heading"
          ><slot class="label" name="label"></slot
        ></heading>
        <div class="sgroup-content"><slot name="content"></slot></div>
      </aside>
    `;
  }
}
