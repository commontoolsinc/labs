import { LitElement, css, html } from "lit";
import { customElement } from "lit/decorators.ts";
import { base } from "../shared/styles.ts";

@customElement("os-tile")
export class OsTile extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        display: block;
        width: 100%;
      }

      .tile {
        display: block;
        aspect-ratio: 1 / 1;
        border-radius: var(--radius-2);
        border: 1px solid var(--c-border);
      }
    `,
  ];

  override render() {
    return html`
      <div class="tile">
        <slot></slot>
      </div>
    `;
  }
}
