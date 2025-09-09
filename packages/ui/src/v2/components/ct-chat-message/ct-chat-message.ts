import { css, html } from "lit";
import { property } from "lit/decorators.js";
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
        padding: var(--ct-spacing-3, 0.75rem) var(--ct-spacing-4, 1rem);
        border-radius: var(--ct-border-radius-lg, 0.5rem);
        word-wrap: break-word;
        position: relative;
        width: fit-content;
        max-width: 100%;
        animation: messageSlideIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
        transform-origin: bottom;
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
        background-color: var(--ct-color-primary-500, #3b82f6);
        color: var(--ct-color-primary-50, #eff6ff);
      }

      .message-assistant {
        background-color: var(--ct-color-gray-100, #f3f4f6);
        color: var(--ct-color-gray-900, #111827);
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
        margin-right: var(--ct-spacing-2, 0.5rem);
      }

      :host([role="user"]) .message-avatar {
        margin-right: 0;
        margin-left: var(--ct-spacing-2, 0.5rem);
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
        background-color: var(--ct-color-primary-500, #3b82f6);
        color: var(--ct-color-primary-50, #eff6ff);
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
        margin-top: var(--ct-spacing-2, 0.5rem);
        display: flex;
        flex-direction: column;
        gap: var(--ct-spacing-1, 0.25rem);
        width: 100%;
        max-width: 500px;
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
        font-family: var(
          --ct-font-mono,
          ui-monospace,
          "Cascadia Code",
          "Source Code Pro",
          Menlo,
          Consolas,
          "DejaVu Sans Mono",
          monospace
        );
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

    return marked(content) as string;
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
          ${this._renderToolAttachments()}
        </div>
      </div>
    `;
  }
}

globalThis.customElements.define("ct-chat-message", CTChatMessage);
