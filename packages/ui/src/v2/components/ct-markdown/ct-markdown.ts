import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { consume } from "@lit/context";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { classMap } from "lit/directives/class-map.js";
import { marked } from "marked";
import { BaseElement } from "../../core/base-element.ts";
import "../ct-copy-button/ct-copy-button.ts";
import "../ct-cell-link/ct-cell-link.ts";
import {
  applyThemeToElement,
  type CTTheme,
  themeContext,
} from "../theme-context.ts";
import { type CellHandle, isCellHandle } from "@commontools/runtime-client";

export type MarkdownVariant = "default" | "inverse";

/**
 * CTMarkdown - Renders markdown content with syntax highlighting and copy buttons
 *
 * @element ct-markdown
 *
 * @attr {string} content - The markdown content to render (string or CellHandle<string>)
 * @attr {string} variant - Visual variant: "default" or "inverse" (for light text on dark bg)
 * @attr {boolean} streaming - Shows a blinking cursor at the end (for streaming content)
 * @attr {boolean} compact - Reduces paragraph spacing for more compact display
 *
 * @csspart content - The markdown content wrapper
 *
 * @fires ct-checkbox-change - Fired when a task list checkbox is toggled. Detail: { index: number, checked: boolean }
 *
 * @cssprop [--ct-markdown-inverse-border=rgba(255,255,255,0.3)] - Border color for inverse variant
 * @cssprop [--ct-markdown-inverse-surface=rgba(255,255,255,0.2)] - Surface color for inverse variant (code blocks)
 * @cssprop [--ct-markdown-inverse-surface-subtle=rgba(255,255,255,0.1)] - Subtle surface for inverse (table headers)
 * @cssprop [--ct-markdown-inverse-accent=rgba(255,255,255,0.6)] - Accent color for inverse (blockquote border)
 *
 * @example
 * <ct-markdown content="# Hello World\n\nThis is **bold** text."></ct-markdown>
 *
 * @example
 * <ct-markdown content="```js\nconsole.log('hello');\n```"></ct-markdown>
 *
 * @example
 * <ct-markdown .content=${myCell} streaming></ct-markdown>
 *
 * @example
 * <ct-markdown .content=${myCell} compact></ct-markdown>
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

      /* Streaming cursor */
      .markdown-content.streaming::after {
        content: "▊";
        animation: blink 1s infinite;
        margin-left: 2px;
        color: currentColor;
      }

      @keyframes blink {
        0%,
        50% {
          opacity: 1;
        }
        51%,
        100% {
          opacity: 0;
        }
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

      /* Inverse variant heading adjustments */
      .markdown-content.inverse h1,
      .markdown-content.inverse h2 {
        border-bottom-color: var(
          --ct-markdown-inverse-border,
          rgba(255, 255, 255, 0.3)
        );
      }

      .markdown-content.inverse h6 {
        color: inherit;
        opacity: 0.8;
      }

      /* Paragraphs */
      .markdown-content p {
        margin: 0;
      }

      .markdown-content p:not(:last-child) {
        margin-bottom: var(--ct-theme-spacing, var(--ct-spacing-3, 0.75rem));
      }

      /* Compact mode paragraph spacing */
      .markdown-content.compact p:not(:last-child) {
        margin-bottom: var(
          --ct-theme-spacing-compact,
          var(--ct-spacing-1, 0.25rem)
        );
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

      /* Inverse variant links */
      .markdown-content.inverse a {
        color: inherit;
        text-decoration: underline;
        opacity: 0.9;
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

      /* Inverse variant inline code */
      .markdown-content.inverse code {
        background-color: var(
          --ct-markdown-inverse-surface,
          rgba(255, 255, 255, 0.2)
        );
        color: inherit;
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

      /* Inverse variant code blocks */
      .markdown-content.inverse pre {
        background-color: var(
          --ct-markdown-inverse-surface,
          rgba(255, 255, 255, 0.2)
        );
        border: none;
      }

      .markdown-content.inverse pre code {
        color: inherit;
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

      /* Inverse variant blockquotes */
      .markdown-content.inverse blockquote {
        border-left-color: var(
          --ct-markdown-inverse-accent,
          rgba(255, 255, 255, 0.6)
        );
        color: inherit;
        opacity: 0.9;
      }

      /* Horizontal rules */
      .markdown-content hr {
        border: none;
        border-top: 1px solid var(--ct-theme-color-border, #e5e7eb);
        margin: 1.5em 0;
      }

      .markdown-content.inverse hr {
        border-top-color: var(
          --ct-markdown-inverse-border,
          rgba(255, 255, 255, 0.3)
        );
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

      /* Inverse variant tables */
      .markdown-content.inverse th,
      .markdown-content.inverse td {
        border-color: var(
          --ct-markdown-inverse-border,
          rgba(255, 255, 255, 0.3)
        );
      }

      .markdown-content.inverse th {
        background-color: var(
          --ct-markdown-inverse-surface-subtle,
          rgba(255, 255, 255, 0.1)
        );
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
        cursor: pointer;
      }
    `,
  ];

  @property({ attribute: false })
  declare content: CellHandle<string> | string;

  @property({ type: String, reflect: true })
  declare variant: MarkdownVariant;

  @property({ type: Boolean, reflect: true })
  declare streaming: boolean;

  @property({ type: Boolean, reflect: true })
  declare compact: boolean;

  @consume({ context: themeContext, subscribe: true })
  @property({ attribute: false })
  declare theme?: CTTheme;

  private _unsubscribe: (() => void) | null = null;

  constructor() {
    super();
    this.content = "";
    this.variant = "default";
    this.streaming = false;
    this.compact = false;
  }

  private _getContentValue(): string {
    if (isCellHandle<string>(this.content)) {
      return this.content.get() ?? "";
    }
    return this.content ?? "";
  }

  private _renderMarkdown(content: string): string {
    if (!content) return "";

    // Use marked.parse with options to avoid mutating global state
    let renderedHtml = marked.parse(content, {
      breaks: true,
      gfm: true,
    }) as string;

    // Wrap code blocks with copy buttons
    renderedHtml = this._wrapCodeBlocksWithCopyButtons(renderedHtml);

    // Replace cell links with ct-cell-link
    renderedHtml = this._replaceCellLinks(renderedHtml);

    // TODO(CT-1088): XSS VULNERABILITY - This component uses unsafeHTML without sanitization!
    //
    // We need to sanitize the HTML to prevent XSS attacks. Originally we used DOMPurify
    // but it added a dependency (isomorphic-dompurify) that caused lockfile issues.
    //
    // Options to fix this:
    // 1. Add DOMPurify back with proper lockfile management
    // 2. Implement our own sanitizer that allows our custom elements (ct-cell-link, ct-copy-button)
    // 3. Find an alternative sanitization library
    //
    // For now, only use this component with trusted markdown content!
    //
    // Security note: The _escapeForAttribute() method helps prevent attribute injection,
    // but this doesn't protect against <script> tags or other HTML-based XSS vectors.

    return renderedHtml;
  }

  private _replaceCellLinks(html: string): string {
    // Matches <a href="/of:...">Name</a>
    // Supports LLM-friendly links starting with /of: or similar schemes
    return html.replace(
      /<a href="(\/[a-zA-Z0-9]+:[^"]+)">([^<]*)<\/a>/g,
      (_match, link, text) => {
        return `<ct-cell-link link="${link}" label="${
          this._escapeForAttribute(text)
        }"></ct-cell-link>`;
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
    // Use browser API when available for complete entity decoding
    if (typeof document !== "undefined") {
      const textarea = document.createElement("textarea");
      textarea.innerHTML = text;
      return textarea.value;
    }

    // Fallback for SSR/test environments - decode common entities
    return text
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&#x2F;/g, "/")
      .replace(/&nbsp;/g, " ")
      .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
      .replace(
        /&#x([0-9a-fA-F]+);/g,
        (_, hex) => String.fromCharCode(parseInt(hex, 16)),
      );
  }

  private _escapeForAttribute(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  override willUpdate(
    changedProperties: Map<string | number | symbol, unknown>,
  ) {
    super.willUpdate(changedProperties);

    // Handle Cell subscription before render so first render has correct value
    if (changedProperties.has("content")) {
      // Clean up previous subscription
      if (this._unsubscribe) {
        this._unsubscribe();
        this._unsubscribe = null;
      }

      // Subscribe to new Cell if it's a Cell
      if (this.content && isCellHandle(this.content)) {
        this._unsubscribe = this.content.subscribe(() => {
          this.requestUpdate();
        });
      }
    }
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

    // Attach click handlers to checkboxes after content is rendered
    this._attachCheckboxHandlers();
  }

  private _attachCheckboxHandlers() {
    const container = this.shadowRoot?.querySelector(".markdown-content");
    if (!container) return;

    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach((checkbox, index) => {
      const inputEl = checkbox as HTMLInputElement;

      // Remove the disabled attribute that marked adds by default
      inputEl.removeAttribute("disabled");

      // Remove existing handler to prevent duplicates
      inputEl.removeEventListener("change", this._handleCheckboxChange);

      // Store index as data attribute for retrieval in handler
      inputEl.dataset.checkboxIndex = String(index);

      // Add new handler
      inputEl.addEventListener("change", this._handleCheckboxChange);
    });
  }

  private _handleCheckboxChange = (event: Event) => {
    const checkbox = event.target as HTMLInputElement;
    const index = parseInt(checkbox.dataset.checkboxIndex ?? "0", 10);
    const checked = checkbox.checked;

    this.dispatchEvent(
      new CustomEvent("ct-checkbox-change", {
        detail: { index, checked },
        bubbles: true,
        composed: true,
      }),
    );
  };

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
  }

  private _updateThemeProperties() {
    if (!this.theme) return;
    applyThemeToElement(this, this.theme);
  }

  override render() {
    const contentValue = this._getContentValue();
    const renderedContent = this._renderMarkdown(contentValue);

    const classes = {
      "markdown-content": true,
      inverse: this.variant === "inverse",
      streaming: this.streaming,
      compact: this.compact,
    };

    return html`
      <div class="${classMap(classes)}" part="content">
        ${unsafeHTML(renderedContent)}
      </div>
    `;
  }
}

globalThis.customElements.define("ct-markdown", CTMarkdown);
