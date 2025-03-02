import { css, html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
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

@customElement("common-suggestions")
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

  @property({ type: Array })
  accessor suggestions: Array<Suggestion> = [];
  @property({ type: Number })
  accessor limit = 3;
  @property({ type: String })
  accessor gap = "sm";
  @property({ type: String })
  accessor pad = "none";

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
