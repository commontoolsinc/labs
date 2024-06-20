import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import {repeat} from "lit/directives/repeat.js";
import { readSuggestion, Suggestion, suggestion } from "./common-suggestion.js";
import { getId } from "./identifiable.js";

export class SelectSuggestionEvent extends Event {
  detail: Suggestion;

  constructor(suggestion: Suggestion) {
    super('select-suggestion', {bubbles: true, composed: true});
    this.detail = suggestion;
  }
}

@customElement("common-suggestions")
export class CommonSuggestionsElement extends LitElement {
  static override styles = css`
    :host {
      display: block;
    }
  `;

  @property({ type: Array }) suggestions: Array<Suggestion> = [];
  @property({ type: Number }) limit = 3;

  override render() {
    const onclick = (event: Event) => {
      const suggestion = readSuggestion(event.target);
      if (suggestion) {
        this.dispatchEvent(
          new SelectSuggestionEvent(suggestion)
        );
      }
    }

    const suggestions = this.suggestions.slice(0, this.limit);

    return html`
    <common-vstack @click="${onclick}">
      ${repeat(suggestions, getId, suggestion)}
    </common-vstack>
    `;
  }
}