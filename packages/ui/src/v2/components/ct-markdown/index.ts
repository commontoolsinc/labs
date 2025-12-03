import { CTMarkdown } from "./ct-markdown.ts";

if (!customElements.get("ct-markdown")) {
  customElements.define("ct-markdown", CTMarkdown);
}

export { CTMarkdown };
export type { CTMarkdown as CTMarkdownElement } from "./ct-markdown.ts";
export type { MarkdownVariant } from "./ct-markdown.ts";
