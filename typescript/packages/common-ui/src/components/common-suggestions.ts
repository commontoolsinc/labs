import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import {
  readSuggestion,
  Suggestion,
  suggestionTemplate,
} from "./common-suggestion.js";
import { getId } from "./identifiable.js";
import { view } from "../hyperscript/render.js";
import { eventProps } from "../hyperscript/schema-helpers.js";

export const suggestions = view("common-suggestions", {
  ...eventProps(),
  id: { type: "string" },
  suggestions: { type: "array" },
  limit: { type: "number" },
});

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

  @property({ type: Array }) suggestions: Array<Suggestion> = [];
  @property({ type: Number }) limit = 3;
  @property({ type: String }) gap = "sm";
  @property({ type: String }) pad = "none";

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
