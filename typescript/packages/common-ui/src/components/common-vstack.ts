import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { baseStyles } from "./style.js";
import { view } from "../hyperscript/render.js";
import { eventProps } from "../hyperscript/schema-helpers.js";

export const vstack = view("common-vstack", {
  ...eventProps(),
  gap: { type: "string" },
  pad: { type: "string" },
});

@customElement("common-vstack")
export class CommonVstackElement extends LitElement {
  @property({ type: String, reflect: true }) gap?: string;
  @property({ type: String, reflect: true }) pad?: string;

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
