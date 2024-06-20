import { LitElement, html, css } from "lit";
import { customElement } from "lit/decorators.js";
import { baseStyles } from "../style.js";
import { Identifiable } from "../../identifiable.js";

@customElement("common-suggestion")
export class CommonSuggestionElement extends LitElement {
  static override styles = [
    baseStyles,
    css`
    :host {
      --button-background: #000;
      --button-color: #fff;
      --height: var(--min-touch-size);
      display: block;
    }
    
    .suggestion {
      align-items: center;
      border-top: 1px solid #e0e0e0;
      box-sizing: border-box;
      display: flex;
      font-size: var(--body-size);
      height: var(--height);
      line-height: 20px;
      padding: 8px 20px;
      gap: var(--gap, 16px);
    }
    `
  ];

  override render() {
    return html`
    <div class="suggestion">
      <slot></slot>
    </div>
    `;
  }
}

/** Read suggestion element to Suggestion record */
export const readSuggestion = (
  element: any
): Suggestion | null => {
  if (!(element instanceof CommonSuggestionElement)) {
    return null;
  }
  const id = element.id;
  const title = element.textContent ?? "";
  return { id, title };
}

export type Suggestion = Identifiable & {
  title: string;
};

export const suggestion = (suggestion: Suggestion) => html`
  <common-suggestion id="${suggestion.id}">
    ${suggestion.title}
  </common-suggestion>`
