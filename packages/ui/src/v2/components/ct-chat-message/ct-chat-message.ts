import { css, html, unsafeCSS } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { marked } from "marked";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CTChatMessage - Chat message component with markdown support
 *
 * @element ct-chat-message
 *
 * @attr {string} role - The role of the message sender ("user" | "assistant")
 * @attr {string} content - The message content (supports markdown)
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
        width: 100%;
        margin-bottom: var(--ct-spacing-2, 0.5rem);
      }

      :host([role="user"]) {
        justify-content: flex-end;
      }

      :host([role="assistant"]) {
        justify-content: flex-start;
      }

      .message {
        max-width: 70%;
        padding: var(--ct-spacing-3, 0.75rem) var(--ct-spacing-4, 1rem);
        border-radius: var(--ct-border-radius-lg, 0.5rem);
        word-wrap: break-word;
        position: relative;
        width: fit-content;
      }

      .message-user {
        background-color: var(--ct-color-primary-500, #3b82f6);
        color: var(--ct-color-primary-50, #eff6ff);
      }

      .message-assistant {
        background-color: var(--ct-color-gray-100, #f3f4f6);
        color: var(--ct-color-gray-900, #111827);
      }

      .message-content {
        line-height: 1.5;
      }

      /* Markdown styling */
      .message-content p {
        margin: 0;
      }

      .message-content p:not(:last-child) {
        margin-bottom: var(--ct-spacing-2, 0.5rem);
      }

      .message-content code {
        background-color: rgba(0, 0, 0, 0.1);
        padding: 0.125rem 0.25rem;
        border-radius: var(--ct-border-radius, 0.25rem);
        font-family: var(--ct-font-mono, ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, 'DejaVu Sans Mono', monospace);
        font-size: 0.875em;
      }

      .message-content pre {
        background-color: rgba(0, 0, 0, 0.1);
        padding: var(--ct-spacing-3, 0.75rem);
        border-radius: var(--ct-border-radius, 0.25rem);
        overflow-x: auto;
        margin: var(--ct-spacing-2, 0.5rem) 0;
      }

      .message-content pre code {
        background-color: transparent;
        padding: 0;
      }

      .message-content ul,
      .message-content ol {
        margin: var(--ct-spacing-2, 0.5rem) 0;
        padding-left: var(--ct-spacing-4, 1rem);
      }

      .message-content blockquote {
        border-left: 4px solid rgba(0, 0, 0, 0.2);
        margin: var(--ct-spacing-2, 0.5rem) 0;
        padding-left: var(--ct-spacing-3, 0.75rem);
        font-style: italic;
      }

      /* Adjust colors for user messages */
      .message-user .message-content code,
      .message-user .message-content pre {
        background-color: rgba(255, 255, 255, 0.2);
      }

      .message-user .message-content blockquote {
        border-left-color: rgba(255, 255, 255, 0.4);
      }
    `,
  ];

  static override properties = {
    role: { type: String, reflect: true },
    content: { type: String },
  };

  declare role: "user" | "assistant";
  declare content: string;

  constructor() {
    super();
    this.role = "user";
    this.content = "";
  }

  private _renderMarkdown(content: string): string {
    if (!content) return "";
    
    // Configure marked for safer rendering
    marked.setOptions({
      breaks: true,
      gfm: true,
    });
    
    return marked(content) as string;
  }

  override render() {
    const messageClass = `message message-${this.role}`;
    const renderedContent = this._renderMarkdown(this.content);

    return html`
      <div class="${messageClass}">
        <div class="message-content">
          ${unsafeHTML(renderedContent)}
        </div>
      </div>
    `;
  }
}

globalThis.customElements.define("ct-chat-message", CTChatMessage);