import { css, html, LitElement } from "lit";
import { customElement } from "lit/decorators.js";
import { baseStyles } from "./style.js";

@customElement("common-vstack")
export class CommonVstackElement extends LitElement {
  accessor gap: string | undefined = undefined;
  accessor pad: string | undefined = undefined;

  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
      }

      .stack {
        display: flex;
        flex-direction: column;
        gap: var(--pad);
      }

      :host([gap="none"]) .stack {
        gap: 0;
      }

      :host([gap="sm"]) .stack {
        gap: var(--gap-sm);
      }

      :host([gap="md"]) .stack {
        gap: var(--gap-md);
      }

      :host([gap="lg"]) .stack {
        gap: var(--gap-lg);
      }

      :host([gap="xl"]) .stack {
        gap: var(--gap-xl);
      }

      :host([pad="md"]) .stack {
        padding: var(--pad-md);
      }

      :host([pad="lg"]) .stack {
        padding: var(--pad-lg);
      }

      :host([pad="xl"]) .stack {
        padding: var(--pad-xl);
      }

      :host([pad="2xl"]) .stack {
        padding: var(--pad-2xl);
      }
    `,
  ];

  override render() {
    return html` <div class="stack">
      <slot></slot>
    </div>`;
  }
}
