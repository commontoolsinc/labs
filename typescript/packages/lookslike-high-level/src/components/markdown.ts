import { LitElement, html } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { until } from "lit/directives/until.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { marked } from "marked";

export function markdownToHtml(markdown: string) {
  return marked(markdown);
}

@customElement("common-markdown")
export default class MarkdownElement extends LitElement {
  @property({ type: String }) markdown = "";
  @property({ type: Boolean }) safe = false;

  async renderMarkdown() {
    return unsafeHTML(await marked(this.markdown));
  }

  override render() {
    return html`
      <style>
        font-family: serif;
      </style>
      ${until(this.renderMarkdown(), html``)}
    `;
  }
}
