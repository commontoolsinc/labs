import { css, html, LitElement } from "lit";
import { baseStyles } from "./style.ts";
import { Identifiable } from "./identifiable.ts";

export class CommonSuggestionElement extends LitElement {
  static override styles = [
    baseStyles,
    css`
      :host {
        --min-height: var(--min-touch-size);
        --width: fit-content;
        display: block;
        width: var(--width);
      }

      .suggestion {
        background: var(--secondary-background);
        border-radius: calc(var(--min-height) / 2);
        cursor: pointer;
        display: flex;
        align-items: center;
        box-sizing: border-box;
        font-size: var(--body-size);
        line-height: 20px;
        min-height: var(--min-height);
        padding: 12px 20px;
        width: var(--width);
        gap: var(--gap, 16px);
      }
    `,
  ];

  override render() {
    return html`
      <div class="suggestion">
        <slot></slot>
      </div>
    `;
  }
}
globalThis.customElements.define("common-suggestion", CommonSuggestionElement);

/** Read suggestion element to Suggestion record */
export const readSuggestion = (element: any): Suggestion | null => {
  if (!(element instanceof CommonSuggestionElement)) {
    return null;
  }
  const id = element.id;
  const title = element.textContent ?? "";
  return { id, title };
};

export type Suggestion = Identifiable & {
  title: string;
};

export const suggestionTemplate = (suggestion: Suggestion) =>
  html`
    <common-suggestion id="${suggestion.id}"> ${suggestion
      .title} </common-suggestion>
  `;
