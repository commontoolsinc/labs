import { LitElement, html, css } from "lit-element";
import { customElement } from "lit/decorators.js";
import { base } from "../styles.js";

const styles = css`
  :host {
    --sidebar-width: calc(var(--unit) * 100);
    display: grid;
    grid-template-columns: var(--sidebar-width) 1fr;
    grid-template-areas: "sidebar main";
    min-height: 100dvh;
  }

  com-app-grid-sidebar {
    grid-area: sidebar;
    background-color: var(--color-secondary-background);
  }

  com-app-grid-main {
    grid-area: main;
    container-type: inline-size;
  }
`;

@customElement("com-app-grid")
export class ComAppGrid extends LitElement {
  static styles = [base, styles];

  render() {
    return html`
      <com-app-grid-main>
        <slot name="main"></slot>
      </com-app-grid-main>
      <com-app-grid-sidebar>
        <slot name="sidebar"></slot>
      </com-app-grid-sidebar>
    `;
  }
}
