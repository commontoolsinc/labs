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

      .sgroup-heading {
        padding-left: var(--pad);
        padding-right: var(--pad);
      }

      :host([safearea]) .sgroup-content {
        padding-left: var(--pad);
        padding-right: var(--pad);
      }
    `,
  ];

  override render() {
    return html`
      <aside class="sgroup vstack">
        <heading class="sgroup-heading"
          ><slot class="label" name="label"></slot
        ></heading>
        <div class="sgroup-content"><slot></slot></div>
      </aside>
    `;
  }
}
