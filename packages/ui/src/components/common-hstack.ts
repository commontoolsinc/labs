import { css, html, LitElement } from "lit";
import { baseStyles } from "./style.ts";

export class CommonHstackElement extends LitElement {
  static override properties = {
    gap: { type: String, reflect: true },
    pad: { type: String, reflect: true },
  };

  declare gap: string;
  declare pad: string;

  constructor() {
    super();
    this.gap = "";
    this.pad = "";
  }

  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
      }

      .hstack {
        display: flex;
        flex-direction: row;
        align-items: center;
      }

      :host([gap="none"]) .hstack {
        gap: 0;
      }

      :host([gap="sm"]) .hstack {
        gap: var(--gap-sm);
      }

      :host([gap="md"]) .hstack {
        gap: var(--gap-md);
      }

      :host([gap="lg"]) .hstack {
        gap: var(--gap-lg);
      }

      :host([gap="xl"]) .hstack {
        gap: var(--gap-xl);
      }

      :host([gap="2xl"]) .hstack {
        gap: var(--gap-2xl);
      }

      :host([pad="md"]) .hstack {
        padding: var(--pad-md);
      }

      :host([pad="lg"]) .hstack {
        padding: var(--pad-lg);
      }

      :host([pad="xl"]) .hstack {
        padding: var(--pad-xl);
      }

      :host([pad="2xl"]) .hstack {
        padding: var(--pad-2xl);
      }
    `,
  ];

  override render() {
    return html`
      <div class="hstack">
        <slot></slot>
      </div>
    `;
  }
}
globalThis.customElements.define("common-hstack", CommonHstackElement);
