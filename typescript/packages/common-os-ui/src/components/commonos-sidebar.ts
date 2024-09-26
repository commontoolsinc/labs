import { LitElement, css, html } from "lit-element";
import { customElement } from "lit/decorators.js";
import { base } from "../shared/styles.js";}

@customElement("common-datatable")
export class CommonOsSidebar extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        /* 480px */
        --sidebar-width: calc(var(--u) * 120);
        width: var(--sidebar-width);
        display: flex;
        flex-direction: column;
        background-color: var(--bg-2);
        padding: 16px;
        box-shadow: 2px 0 5px rgba(0, 0, 0, 0.1);
      }
      nav {
        display: flex;
        flex-direction: column;
      }
      a {
        color: #333;
        text-decoration: none;
        padding: 8px 0;
        font-size: 16px;
        transition: color 0.3s ease;
      }
      a:hover {
        color: #007bff;
      }
    `,
  ];

  override render() {
    return html`
      <nav>
        <a href="/">Home</a>
        <a href="/about">About</a>
        <a href="/services">Services</a>
        <a href="/contact">Contact</a>
      </nav>
    `;
  }
}
