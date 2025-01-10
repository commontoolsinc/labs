import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { view } from "../hyperscript/render.js";
import { baseStyles } from "./style.js";
import { eventProps } from "../hyperscript/schema-helpers.js";

export const hstack = view("common-hstack", {
  ...eventProps(),
  gap: { type: "string" },
  pad: { type: "string" },
});

@customElement("common-hstack")
export class CommonHstackElement extends LitElement {
  @property({ type: String, reflect: true }) gap?: string;
  @property({ type: String, reflect: true }) pad?: string;

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
    return html` <div class="hstack">
      <slot></slot>
    </div>`;
  }
}
