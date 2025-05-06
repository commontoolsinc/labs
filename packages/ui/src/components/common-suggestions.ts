import { css, html, LitElement } from "lit";
import { repeat } from "lit/directives/repeat.js";
import {
  readSuggestion,
  Suggestion,
  suggestionTemplate,
} from "./common-suggestion.ts";
import { getId } from "./identifiable.ts";

export class SelectSuggestionEvent extends Event {
  detail: Suggestion;

  constructor(suggestion: Suggestion) {
    super("select-suggestion", { bubbles: true, composed: true });
    this.detail = suggestion;
  }
}

export class CommonSuggestionsElement extends LitElement {
  static override styles = css`
    :host {
      display: block;
    }

    .suggestions {
      display: flex;
      flex-direction: column;
      gap: var(--unit);
    }

    :host([pad="md"]) .suggestions {
      padding: var(--pad);
    }
  `;

  static override properties = {
    suggestions: { type: Array },
    limit: { type: Number },
    gap: { type: String },
    pad: { type: String },
  };

  declare suggestions: Array<Suggestion>;
  declare limit: number;
  declare gap: string;
  declare pad: string;

  constructor() {
    super();
    this.suggestions = [];
    this.limit = 3;
    this.gap = "sm";
    this.pad = "none";
  }

  override render() {
    const onclick = (event: Event) => {
      const suggestion = readSuggestion(event.target);
      if (suggestion) {
        this.dispatchEvent(new SelectSuggestionEvent(suggestion));
      }
    };

    // FIXME(ja): Cannot read properties of undefined (reading 'slice')
    // broken on main - doesn't seem to be regression of the llm changes
    const suggestions = this.suggestions.slice(0, this.limit);

    return html`
      <div class="suggestions" @click="${onclick}">
        ${repeat(suggestions, getId, suggestionTemplate)}
      </div>
    `;
  }
}
globalThis.customElements.define(
  "common-suggestions",
  CommonSuggestionsElement,
);
