import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { consume } from "@lit/context";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { marked } from "marked";
import { BaseElement } from "../../core/base-element.ts";
import "../ct-tool-call/ct-tool-call.ts";
import type {
  BuiltInLLMContent,
  BuiltInLLMMessage,
  BuiltInLLMTextPart,
  BuiltInLLMToolCallPart,
  BuiltInLLMToolResultPart,
} from "@commontools/api";
import { themeContext, type CTTheme, applyThemeToElement } from "../theme-context.ts";

/**
 * CTChatMessage - Chat message component with markdown support
 *
 * @element ct-chat-message
 *
 * @attr {string} role - The role of the message sender ("user" | "assistant")
 * @attr {string|array} content - The message content (supports markdown and structured content)
 * @attr {string} avatar - Avatar URL for the message sender
 * @attr {string} name - Display name for the message sender
 *
 * @example
 * <ct-chat-message
 *   role="user"
 *   content="Hello, how are you?"
 * ></ct-chat-message>
 *
 * <ct-chat-message
 *   role="assistant"
 *   content="I'm doing well, thank you for asking!"
 * ></ct-chat-message>
 */
export class CTChatMessage extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        width: 100%;
        font-family: var(--ct-theme-font-family, system-ui, -apple-system, sans-serif);
      }

      .message-wrapper {
        display: flex;
        width: 100%;
        align-items: flex-start;
      }

      :host([role="user"]) .message-wrapper {
        justify-content: flex-end;
      }

      :host([role="assistant"]) .message-wrapper {
        justify-content: flex-start;
      }

      .message {
        padding: var(--ct-theme-padding-message, var(--ct-spacing-3, 0.75rem));
        border-radius: var(--ct-theme-border-radius, 0.5rem);
        word-wrap: break-word;
        position: relative;
        width: fit-content;
        max-width: 100%;
        animation: messageSlideIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
        transform-origin: bottom;
      }

      /* Role-specific message styling */
      :host([role="user"]) .message {
        background-color: var(--ct-theme-color-accent, var(--ct-color-blue-500, #3b82f6));
        color: var(--ct-theme-color-accent-foreground, var(--ct-color-white, #ffffff));
      }

      :host([role="assistant"]) .message {
        background-color: var(--ct-theme-color-surface, var(--ct-color-gray-100, #f3f4f6));
        color: var(--ct-theme-color-text, var(--ct-color-gray-900, #111827));
      }

      @keyframes messageSlideIn {
        0% {
          opacity: 0;
          transform: translateY(10px) scale(0.95);
        }
        100% {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }

      /* Streaming text effect - can be triggered by adding 'streaming' class */
      .message.streaming .message-content {
        animation: none;
        opacity: 1;
      }

      .message.streaming .message-content::after {
        content: "▊";
        animation: blink 1s infinite;
        margin-left: 2px;
        color: currentColor;
      }

      @keyframes blink {
        0%, 50% {
          opacity: 1;
        }
        51%, 100% {
          opacity: 0;
        }
      }

      .message-user {
        background-color: var(--ct-theme-color-primary, #3b82f6);
        color: var(--ct-theme-color-primary-foreground, #ffffff);
      }

      .message-assistant {
        color: var(--ct-theme-color-text, #111827);
      }

      .message-content {
        line-height: 1.5;
        animation: textFadeIn 0.4s ease-out 0.1s both;
      }

      /* Avatar styling */
      .message-avatar {
        width: 32px;
        height: 32px;
        flex-shrink: 0;
        margin-right: var(--ct-theme-spacing-normal, var(--ct-spacing-2, 0.5rem));
      }

      :host([role="user"]) .message-avatar {
        margin-right: 0;
        margin-left: var(--ct-theme-spacing-normal, var(--ct-spacing-2, 0.5rem));
      }

      :host([role="user"]) .message-wrapper {
        flex-direction: row-reverse;
      }

      .message-avatar img {
        width: 100%;
        height: 100%;
        border-radius: 50%;
        object-fit: cover;
      }

      .avatar-fallback {
        width: 100%;
        height: 100%;
        border-radius: 50%;
        background-color: var(--ct-theme-color-primary, #3b82f6);
        color: var(--ct-theme-color-primary-foreground, #ffffff);
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: 600;
        font-size: 0.75rem;
      }

      /* Message bubble */
      .message-bubble {
        display: flex;
        flex-direction: column;
        max-width: 90%;
        width: fit-content;
      }

      :host([role="user"]) .message-bubble {
        align-items: flex-end;
        margin-left: auto;
      }

      :host([role="assistant"]) .message-bubble {
        align-items: flex-start;
        margin-right: auto;
      }

      /* Tool attachments */
      .tool-attachments {
        margin-top: var(--ct-theme-spacing, var(--ct-spacing-2, 0.5rem));
        display: flex;
        flex-direction: column;
        gap: var(--ct-theme-spacing, var(--ct-spacing-2, 0.5rem));
        width: 100%;
        max-width: 500px;
      }

      /* Markdown styling */
      .message-content p {
        margin: 0;
      }

      .message-content p:not(:last-child) {
        margin-bottom: var(--ct-theme-spacing, var(--ct-spacing-2, 0.5rem));
      }

      .message-content code {
        background-color: var(--ct-theme-color-surface, #f9fafb);
        padding: var(--ct-theme-padding-code, var(--ct-spacing-1, 0.25rem));
        border-radius: var(--ct-theme-border-radius, 0.5rem);
        font-family: var(--ct-theme-mono-font-family, ui-monospace, monospace);
        font-size: 0.875em;
      }

      .message-content pre {
        background-color: var(--ct-theme-color-surface, #f9fafb);
        padding: var(--ct-theme-padding-block, var(--ct-spacing-3, 0.75rem));
        border-radius: var(--ct-theme-border-radius, 0.5rem);
        border: 1px solid var(--ct-theme-color-border, #e5e7eb);
        overflow-x: auto;
        margin: var(--ct-theme-spacing-normal, var(--ct-spacing-2, 0.5rem)) 0;
      }

      .message-content pre code {
        background-color: transparent;
        padding: 0;
      }

      .message-content ul,
      .message-content ol {
        margin: var(--ct-theme-spacing, var(--ct-spacing-2, 0.5rem)) 0;
        padding-left: var(--ct-theme-padding, var(--ct-spacing-3, 0.75rem));
      }

      .message-content blockquote {
        border-left: 4px solid var(--ct-theme-color-border, #e5e7eb);
        margin: var(--ct-theme-spacing, var(--ct-spacing-2, 0.5rem)) 0;
        padding-left: var(--ct-theme-padding, var(--ct-spacing-3, 0.75rem));
        font-style: italic;
        color: var(--ct-theme-color-text-muted, #6b7280);
      }

      /* Adjust colors for user messages */
      :host([role="user"]) .message-content code,
      :host([role="user"]) .message-content pre {
        background-color: var(--ct-theme-color-accent-foreground, var(--ct-color-white, #ffffff));
        opacity: 0.2;
      }

      :host([role="user"]) .message-content blockquote {
        border-left-color: var(--ct-theme-color-accent-foreground, var(--ct-color-white, #ffffff));
        opacity: 0.4;
      }

      /* Message actions */
      .message-actions {
        display: flex;
        gap: var(--ct-theme-spacing, var(--ct-spacing-2, 0.5rem));
        margin-top: var(--ct-theme-spacing, var(--ct-spacing-2, 0.5rem));
        opacity: 0;
        transition: opacity var(--ct-theme-animation-duration, 0.2s) ease;
      }

      .message-bubble:hover .message-actions {
        opacity: 1;
      }

      .action-button {
        background: transparent;
        border: 1px solid var(--ct-theme-color-border-muted, #f3f4f6);
        border-radius: var(--ct-theme-border-radius, 0.5rem);
        padding: var(--ct-theme-spacing, var(--ct-spacing-2, 0.5rem));
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all var(--ct-theme-animation-duration, 0.2s) ease;
        color: var(--ct-theme-color-text-muted, #6b7280);
        font-size: 0.75rem;
        min-width: 32px;
        min-height: 32px;
      }

      .action-button:hover {
        background: var(--ct-theme-color-surface-hover, #f3f4f6);
        border-color: var(--ct-theme-color-border, #e5e7eb);
        color: var(--ct-theme-color-text, #111827);
      }

      .action-button:active {
        transform: scale(0.95);
      }

      .action-button.copied {
        background: var(--ct-theme-color-success, #16a34a);
        border-color: var(--ct-theme-color-success, #16a34a);
        color: var(--ct-theme-color-success-foreground, #ffffff);
      }

      /* User message action button styling */
      .message-user .action-button {}

      .message-user .action-button:hover {}

      /* Code block copy button styles */
      .code-block-container {
        position: relative;
      }

      .code-copy-button {
        position: absolute;
        top: var(--ct-theme-spacing, var(--ct-spacing-2, 0.5rem));
        right: var(--ct-theme-spacing, var(--ct-spacing-2, 0.5rem));
        background: var(--ct-theme-color-surface, #f9fafb);
        color: var(--ct-theme-color-text, #111827);
        border: 1px solid var(--ct-theme-color-border, #e5e7eb);
        border-radius: var(--ct-theme-border-radius, 0.5rem);
        padding: var(--ct-theme-spacing, var(--ct-spacing-2, 0.5rem));
        cursor: pointer;
        font-size: 0.75rem;
        opacity: 0;
        transition: all var(--ct-theme-animation-duration, 0.2s) ease;
        display: flex;
        align-items: center;
        gap: var(--ct-theme-spacing, var(--ct-spacing-2, 0.5rem));
        z-index: 1;
      }

      .code-block-container:hover .code-copy-button {
        opacity: 1;
      }

      .code-copy-button:hover {
        background: var(--ct-theme-color-surface-hover, #f3f4f6);
        border-color: var(--ct-theme-color-border, #e5e7eb);
      }

      .code-copy-button:active {
        transform: scale(0.95);
      }

      .code-copy-button.copied {
        background: var(--ct-theme-color-success, #16a34a);
        border-color: var(--ct-theme-color-success, #16a34a);
        color: var(--ct-theme-color-success-foreground, #ffffff);
      }
    `,
  ];

  @property({ type: String, reflect: true })
  declare role: "user" | "assistant";

  @property({ type: Object })
  declare content: BuiltInLLMContent;

  @property({ type: Boolean, reflect: true })
  declare streaming: boolean;

  @property({ type: String })
  declare avatar?: string;

  @property({ type: String })
  declare name?: string;

  @consume({ context: themeContext, subscribe: true })
  @property({ attribute: false })
  declare theme?: CTTheme;

  @property({ type: Boolean })
  private _copied = false;

  private _codeBlockCopiedStates = new Map<string, boolean>();

  constructor() {
    super();
    this.role = "user";
    this.content = "";
    this.streaming = false;
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

    return renderedHtml;
  }

  private _wrapCodeBlocksWithCopyButtons(html: string): string {
    // Use a regex to find <pre><code>...</code></pre> blocks and wrap them
    return html.replace(
      /<pre><code([^>]*)>([\s\S]*?)<\/code><\/pre>/g,
      (match, codeAttrs, codeContent) => {
        const blockId = `code-${Math.random().toString(36).substr(2, 9)}`;
        // Decode HTML entities for the copy content
        const decodedContent = this._decodeHtmlEntities(codeContent);

        return `<div class="code-block-container">
          <pre><code${codeAttrs}>${codeContent}</code></pre>
          <button
            class="code-copy-button"
            data-block-id="${blockId}"
            data-copy-content="${this._escapeForAttribute(decodedContent)}"
            title="Copy code"
          >
            📋
          </button>
        </div>`;
      },
    );
  }

  private _decodeHtmlEntities(text: string): string {
    const textarea = document.createElement("textarea");
    textarea.innerHTML = text;
    return textarea.value;
  }

  private _escapeForAttribute(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  private async _copyMessage() {
    const textContent = this._extractTextContent();
    if (!textContent) return;

    try {
      await navigator.clipboard.writeText(textContent);
      this._copied = true;

      // Reset copied state after 2 seconds
      setTimeout(() => {
        this._copied = false;
        this.requestUpdate();
      }, 2000);

      this.requestUpdate();
    } catch (err) {
      console.error("Failed to copy message:", err);
    }
  }

  private async _copyCodeBlock(blockId: string, content: string) {
    try {
      // Decode the content from the attribute
      const decodedContent = content
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");

      await navigator.clipboard.writeText(decodedContent);
      this._codeBlockCopiedStates.set(blockId, true);

      // Update the button to show copied state
      const button = this.shadowRoot?.querySelector(
        `[data-block-id="${blockId}"]`,
      ) as HTMLButtonElement;
      if (button) {
        button.textContent = "✓";
        button.classList.add("copied");
        button.title = "Copied!";
      }

      // Reset copied state after 2 seconds
      setTimeout(() => {
        this._codeBlockCopiedStates.set(blockId, false);
        if (button) {
          button.textContent = "📋";
          button.classList.remove("copied");
          button.title = "Copy code";
        }
      }, 2000);
    } catch (err) {
      console.error("Failed to copy code block:", err);
    }
  }

  private _renderToolAttachments() {
    // Extract tool calls and results from content array
    const contentArray = Array.isArray(this.content) ? this.content : [];
    const toolCalls = contentArray.filter(
      (part): part is BuiltInLLMToolCallPart => part.type === "tool-call",
    );
    const toolResults = contentArray.filter(
      (part): part is BuiltInLLMToolResultPart => part.type === "tool-result",
    );

    if (toolCalls.length === 0) {
      return null;
    }

    // Create a map of tool results by tool call ID for matching
    const resultMap = new Map<string, BuiltInLLMToolResultPart>();
    toolResults.forEach((result) => {
      resultMap.set(result.toolCallId, result);
    });

    return html`
      <div class="tool-attachments">
        ${toolCalls.map((toolCall) => {
          const toolResult = resultMap.get(toolCall.toolCallId);
          return html`
            <ct-tool-call
              .call="${toolCall}"
              .result="${toolResult}"
            ></ct-tool-call>
          `;
        })}
      </div>
    `;
  }

  private _extractTextContent(): string {
    if (typeof this.content === "string") {
      return this.content;
    } else if (Array.isArray(this.content)) {
      const textParts = this.content.filter(
        (part): part is BuiltInLLMTextPart => part.type === "text",
      );
      return textParts.map((part) => part.text).join(" ");
    }
    return "";
  }

  private _renderAvatar() {
    if (!this.avatar && !this.name) {
      return null;
    }

    const initials = this.name
      ? this.name
        .split(" ")
        .map((word) => word.charAt(0).toUpperCase())
        .join("")
        .slice(0, 2)
      : "?";

    return html`
      <div class="message-avatar">
        ${this.avatar
          ? html`
            <img src="${this.avatar}" alt="${this.name || "Avatar"}" />
          `
          : html`
            <div class="avatar-fallback">${initials}</div>
          `}
      </div>
    `;
  }

  private _renderMessageActions() {
    const textContent = this._extractTextContent();
    if (!textContent) return null;

    return html`
      <div class="message-actions">
        ${this.role === "assistant"
          ? html`
            <button
              class="action-button ${this._copied ? "copied" : ""}"
              @click="${this._copyMessage}"
              title="${this._copied ? "Copied!" : "Copy message"}"
            >
              ${this._copied ? "✓" : "📋"}
            </button>
          `
          : null}
      </div>
    `;
  }

  override firstUpdated(changedProperties: Map<string | number | symbol, unknown>) {
    super.firstUpdated(changedProperties);
    // Set initial theme properties if theme is available
    if (this.theme) {
      this._updateThemeProperties();
    }
  }

  override updated(changedProperties: Map<string | number | symbol, unknown>) {
    super.updated(changedProperties);

    // Update CSS custom properties when theme changes
    if (changedProperties.has("theme") && this.theme) {
      this._updateThemeProperties();
    }

    // Add event listeners to code copy buttons after render
    if (changedProperties.has("content")) {
      this._setupCodeCopyButtons();
    }
  }

  private _updateThemeProperties() {
    if (!this.theme) return;
    applyThemeToElement(this, this.theme);
  }

  private _setupCodeCopyButtons() {
    const copyButtons = this.shadowRoot?.querySelectorAll(".code-copy-button");
    copyButtons?.forEach((button) => {
      button.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const target = e.target as HTMLButtonElement;
        const blockId = target.getAttribute("data-block-id");
        const content = target.getAttribute("data-copy-content");
        if (blockId && content) {
          this._copyCodeBlock(blockId, content);
        }
      });
    });
  }

  override render() {
    const messageClass = `message message-${this.role}${
      this.streaming ? " streaming" : ""
    }`;

    const textContent = this._extractTextContent();
    const renderedContent = this._renderMarkdown(textContent);

    return html`
      <div class="message-wrapper">
        ${this._renderAvatar()}
        <div class="message-bubble">
          <div class="${messageClass}">
            <div class="message-content">
              ${unsafeHTML(renderedContent)}
            </div>
          </div>
          ${this._renderToolAttachments()} ${this._renderMessageActions()}
        </div>
      </div>
    `;
  }
}

globalThis.customElements.define("ct-chat-message", CTChatMessage);
