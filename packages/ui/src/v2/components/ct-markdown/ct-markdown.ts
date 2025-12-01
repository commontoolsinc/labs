import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { consume } from "@lit/context";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { marked } from "marked";
import { BaseElement } from "../../core/base-element.ts";
import "../ct-copy-button/ct-copy-button.ts";
import "../ct-cell-link/ct-cell-link.ts";
import {
  applyThemeToElement,
  type CTTheme,
  themeContext,
} from "../theme-context.ts";

/**
 * CTMarkdown - Renders markdown content with syntax highlighting and copy buttons
 *
 * @element ct-markdown
 *
 * @attr {string} content - The markdown content to render
 *
 * @example
 * <ct-markdown content="# Hello World\n\nThis is **bold** text."></ct-markdown>
 *
 * @example
 * <ct-markdown content="```js\nconsole.log('hello');\n```"></ct-markdown>
 */
export class CTMarkdown extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
        box-sizing: border-box;
        font-family: var(
          --ct-theme-font-family,
          system-ui,
          -apple-system,
          sans-serif
        );
        line-height: 1.6;
        color: var(--ct-theme-color-text, var(--ct-color-gray-900, #111827));
      }

      *,
      *::before,
      *::after {
        box-sizing: inherit;
      }

      .markdown-content {
        word-wrap: break-word;
      }

      /* Headings */
      .markdown-content h1,
      .markdown-content h2,
      .markdown-content h3,
      .markdown-content h4,
      .markdown-content h5,
      .markdown-content h6 {
        margin-top: 1.5em;
        margin-bottom: 0.5em;
        font-weight: 600;
        line-height: 1.25;
      }

      .markdown-content h1:first-child,
      .markdown-content h2:first-child,
      .markdown-content h3:first-child,
      .markdown-content h4:first-child,
      .markdown-content h5:first-child,
      .markdown-content h6:first-child {
        margin-top: 0;
      }

      .markdown-content h1 {
        font-size: 2em;
        border-bottom: 1px solid var(--ct-theme-color-border, #e5e7eb);
        padding-bottom: 0.3em;
      }

      .markdown-content h2 {
        font-size: 1.5em;
        border-bottom: 1px solid var(--ct-theme-color-border, #e5e7eb);
        padding-bottom: 0.3em;
      }

      .markdown-content h3 {
        font-size: 1.25em;
      }

      .markdown-content h4 {
        font-size: 1em;
      }

      .markdown-content h5 {
        font-size: 0.875em;
      }

      .markdown-content h6 {
        font-size: 0.85em;
        color: var(--ct-theme-color-text-muted, #6b7280);
      }

      /* Paragraphs */
      .markdown-content p {
        margin: 0;
      }

      .markdown-content p:not(:last-child) {
        margin-bottom: var(--ct-theme-spacing, var(--ct-spacing-3, 0.75rem));
      }

      /* Links */
      .markdown-content a {
        color: var(
          --ct-theme-color-accent,
          var(--ct-color-blue-500, #3b82f6)
        );
        text-decoration: none;
      }

      .markdown-content a:hover {
        text-decoration: underline;
      }

      /* Lists */
      .markdown-content ul,
      .markdown-content ol {
        margin: var(--ct-theme-spacing, var(--ct-spacing-3, 0.75rem)) 0;
        padding-left: 2em;
      }

      .markdown-content li {
        margin-bottom: 0.25em;
      }

      .markdown-content li > ul,
      .markdown-content li > ol {
        margin: 0.25em 0;
      }

      /* Inline code */
      .markdown-content code {
        background-color: var(--ct-theme-color-surface, #f9fafb);
        padding: 0.2em 0.4em;
        border-radius: var(--ct-theme-border-radius, 0.375rem);
        font-family: var(--ct-theme-mono-font-family, ui-monospace, monospace);
        font-size: 0.875em;
      }

      /* Code blocks */
      .markdown-content pre {
        background-color: var(--ct-theme-color-surface, #f9fafb);
        padding: var(--ct-theme-padding-block, var(--ct-spacing-3, 0.75rem));
        border-radius: var(--ct-theme-border-radius, 0.5rem);
        border: 1px solid var(--ct-theme-color-border, #e5e7eb);
        overflow-x: auto;
        margin: var(--ct-theme-spacing, var(--ct-spacing-3, 0.75rem)) 0;
      }

      .markdown-content pre code {
        background-color: transparent;
        padding: 0;
        font-size: 0.875em;
      }

      /* Code block container with copy button */
      .code-block-container {
        position: relative;
      }

      .code-copy-button {
        position: absolute;
        top: var(--ct-theme-spacing-normal, var(--ct-spacing-2, 0.5rem));
        right: var(--ct-theme-spacing-normal, var(--ct-spacing-2, 0.5rem));
        opacity: 0;
        transition: opacity var(--ct-theme-animation-duration, 0.2s) ease;
        z-index: 1;
      }

      .code-block-container:hover .code-copy-button {
        opacity: 1;
      }

      /* Blockquotes */
      .markdown-content blockquote {
        border-left: 4px solid var(--ct-theme-color-border, #e5e7eb);
        margin: var(--ct-theme-spacing, var(--ct-spacing-3, 0.75rem)) 0;
        padding-left: var(--ct-theme-padding, var(--ct-spacing-3, 0.75rem));
        font-style: italic;
        color: var(--ct-theme-color-text-muted, #6b7280);
      }

      .markdown-content blockquote p:last-child {
        margin-bottom: 0;
      }

      /* Horizontal rules */
      .markdown-content hr {
        border: none;
        border-top: 1px solid var(--ct-theme-color-border, #e5e7eb);
        margin: 1.5em 0;
      }

      /* Tables */
      .markdown-content table {
        border-collapse: collapse;
        width: 100%;
        margin: var(--ct-theme-spacing, var(--ct-spacing-3, 0.75rem)) 0;
      }

      .markdown-content th,
      .markdown-content td {
        border: 1px solid var(--ct-theme-color-border, #e5e7eb);
        padding: 0.5em 1em;
        text-align: left;
      }

      .markdown-content th {
        background-color: var(--ct-theme-color-surface, #f9fafb);
        font-weight: 600;
      }

      /* Images */
      .markdown-content img {
        max-width: 100%;
        height: auto;
        border-radius: var(--ct-theme-border-radius, 0.5rem);
      }

      /* Strong and emphasis */
      .markdown-content strong {
        font-weight: 600;
      }

      .markdown-content em {
        font-style: italic;
      }

      /* Task lists */
      .markdown-content input[type="checkbox"] {
        margin-right: 0.5em;
      }
    `,
  ];

  @property({ type: String })
  declare content: string;

  @consume({ context: themeContext, subscribe: true })
  @property({ attribute: false })
  declare theme?: CTTheme;

  constructor() {
    super();
    this.content = "";
  }

  private _renderMarkdown(content: string): string {
    if (!content) return "";

    // Configure marked for safer rendering
    marked.setOptions({
      breaks: true,
      gfm: true,
    });

    let renderedHtml = marked(content) as string;

    // Wrap code blocks with copy buttons
    renderedHtml = this._wrapCodeBlocksWithCopyButtons(renderedHtml);

    // Replace cell links with ct-cell-link
    renderedHtml = this._replaceCellLinks(renderedHtml);

    return renderedHtml;
  }

  private _replaceCellLinks(html: string): string {
    // Matches <a href="/of:...">Name</a>
    // Supports LLM-friendly links starting with /of: or similar schemes
    return html.replace(
      /<a href="(\/[a-zA-Z0-9]+:[^"]+)">([^<]*)<\/a>/g,
      (_match, link, text) => {
        return `<ct-cell-link link="${link}" label="${text}"></ct-cell-link>`;
      },
    );
  }

  private _wrapCodeBlocksWithCopyButtons(html: string): string {
    return html.replace(
      /<pre><code([^>]*)>([\s\S]*?)<\/code><\/pre>/g,
      (_match, codeAttrs, codeContent) => {
        const decodedContent = this._decodeHtmlEntities(codeContent);

        return `<div class="code-block-container">
          <pre><code${codeAttrs}>${codeContent}</code></pre>
          <ct-copy-button
            class="code-copy-button"
            text="${this._escapeForAttribute(decodedContent)}"
            variant="ghost"
            size="sm"
            icon-only
          ></ct-copy-button>
        </div>`;
      },
    );
  }

  private _decodeHtmlEntities(text: string): string {
    // Decode common HTML entities without requiring DOM
    return text
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&#x2F;/g, "/")
      .replace(/&nbsp;/g, " ");
  }

  private _escapeForAttribute(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  override firstUpdated(
    changedProperties: Map<string | number | symbol, unknown>,
  ) {
    super.firstUpdated(changedProperties);
    if (this.theme) {
      this._updateThemeProperties();
    }
  }

  override updated(changedProperties: Map<string | number | symbol, unknown>) {
    super.updated(changedProperties);
    if (changedProperties.has("theme") && this.theme) {
      this._updateThemeProperties();
    }
  }

  private _updateThemeProperties() {
    if (!this.theme) return;
    applyThemeToElement(this, this.theme);
  }

  override render() {
    const renderedContent = this._renderMarkdown(this.content);

    return html`
      <div class="markdown-content" part="content">
        ${unsafeHTML(renderedContent)}
      </div>
    `;
  }
}

globalThis.customElements.define("ct-markdown", CTMarkdown);
