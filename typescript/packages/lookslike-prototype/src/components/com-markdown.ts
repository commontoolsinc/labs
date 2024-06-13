import { LitElement, html } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { marked } from "marked";

export async function markdownToHtml(markdown: string) {
  return marked(markdown);
}

@customElement("com-markdown")
export default class MarkdownElement extends LitElement {
  @property() renderedMarkdown: any = html``;
  @property({ type: Boolean }) safe = false;
  @property({ type: String }) markdown = "";

  override render() {
    return html`
      <style>
        font-family: serif;
      </style>
      ${this.renderedMarkdown}
    `;
  }

  override updated(changedProperties: Map<string | number | symbol, unknown>) {
    if (changedProperties.has("markdown")) {
      markdownToHtml(this.markdown).then(
        (r) => (this.renderedMarkdown = html`${unsafeHTML(r)}`)
      );
    }
  }
}
