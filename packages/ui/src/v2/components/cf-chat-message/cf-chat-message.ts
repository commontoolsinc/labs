import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { consume } from "@lit/context";
import { BaseElement } from "../../core/base-element.ts";
import "../cf-tool-call/cf-tool-call.ts";
import "../cf-button/cf-button.ts";
import "../cf-copy-button/cf-copy-button.ts";
import "../cf-markdown/cf-markdown.ts";
import type {
  BuiltInLLMContent,
  BuiltInLLMTextPart,
  BuiltInLLMToolCallPart,
  BuiltInLLMToolResultPart,
} from "@commonfabric/api";
import {
  applyThemeToElement,
  type CFTheme,
  cfThemeContext,
} from "../theme-context.ts";

/**
 * CFChatMessage - Chat message component with markdown support
 *
 * @element cf-chat-message
 *
 * @attr {string} role - The role of the message sender ("user" | "assistant")
 * @attr {string|array} content - The message content (supports markdown and structured content)
 * @attr {string} avatar - Avatar URL for the message sender
 * @attr {string} name - Display name for the message sender
 * @attr {boolean} compact - Hides the copy button and collapses spacing around the message
 *
 * @example
 * <cf-chat-message
 *   role="user"
 *   content="Hello, how are you?"
 * ></cf-chat-message>
 *
 * <cf-chat-message
 *   role="assistant"
 *   content="I'm doing well, thank you for asking!"
 * ></cf-chat-message>
 */
export class CFChatMessage extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        width: 100%;
        font-family: var(
          --cf-theme-font-family,
          system-ui,
          -apple-system,
          sans-serif
        );
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
        padding: var(--cf-theme-padding-message, var(--cf-spacing-3, 0.75rem));
        border-radius: var(--cf-theme-border-radius, 0.5rem);
        word-wrap: break-word;
        position: relative;
        width: fit-content;
        max-width: 100%;
        animation: messageSlideIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
        transform-origin: bottom;
      }

      /* Role-specific message styling */
      :host([role="user"]) .message {
        background-color: var(
          --cf-theme-color-accent,
          var(--cf-color-blue-500, #3b82f6)
        );
        color: var(
          --cf-theme-color-accent-foreground,
          var(--cf-color-white, #ffffff)
        );
      }

      :host([role="assistant"]) .message {
        background-color: var(
          --cf-theme-color-surface,
          var(--cf-color-gray-100, #f3f4f6)
        );
        color: var(--cf-theme-color-text, var(--cf-color-gray-900, #111827));
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

      .message-user {
        background-color: var(--cf-theme-color-primary, #3b82f6);
        color: var(--cf-theme-color-primary-foreground, #ffffff);
      }

      .message-assistant {
        color: var(--cf-theme-color-text, #111827);
      }

      /* cf-markdown inherits color from parent */
      cf-markdown {
        color: inherit;
        line-height: 1.5;
      }

      /* Avatar styling */
      .message-avatar {
        width: 32px;
        height: 32px;
        flex-shrink: 0;
        margin-right: var(--cf-theme-spacing-normal, var(--cf-spacing-2, 0.5rem));
      }

      :host([role="user"]) .message-avatar {
        margin-right: 0;
        margin-left: var(--cf-theme-spacing-normal, var(--cf-spacing-2, 0.5rem));
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
        background-color: var(--cf-theme-color-primary, #3b82f6);
        color: var(--cf-theme-color-primary-foreground, #ffffff);
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
        margin-top: var(--cf-theme-spacing, var(--cf-spacing-2, 0.5rem));
        display: flex;
        flex-direction: column;
        gap: var(--cf-theme-spacing, var(--cf-spacing-2, 0.5rem));
        width: 100%;
        max-width: 500px;
      }

      /* Message actions */
      .message-actions {
        display: flex;
        gap: var(--cf-theme-spacing, var(--cf-spacing-2, 0.5rem));
        margin-top: var(--cf-theme-spacing, var(--cf-spacing-2, 0.5rem));
        opacity: 0;
        transition: opacity var(--cf-theme-animation-duration, 0.2s) ease;
      }

      .message-bubble:hover .message-actions {
        opacity: 1;
      }

      /* Compact mode styles */
      :host([compact]) .message {
        padding: var(--cf-theme-padding-compact, var(--cf-spacing-2, 0.5rem));
      }

      :host([compact]) .message-actions {
        display: none;
      }

      :host([compact]) .message-avatar {
        margin-right: var(--cf-theme-spacing-compact, var(--cf-spacing-1, 0.25rem));
      }

      :host([compact][role="user"]) .message-avatar {
        margin-right: 0;
        margin-left: var(--cf-theme-spacing-compact, var(--cf-spacing-1, 0.25rem));
      }

      :host([compact]) .tool-attachments {
        margin-top: var(--cf-theme-spacing-compact, var(--cf-spacing-1, 0.25rem));
        gap: var(--cf-theme-spacing-compact, var(--cf-spacing-1, 0.25rem));
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

  @property({ type: Boolean, reflect: true })
  declare compact?: boolean;

  @consume({ context: cfThemeContext, subscribe: true })
  @property({ attribute: false })
  declare theme?: CFTheme;

  constructor() {
    super();
    this.role = "user";
    this.content = "";
    this.streaming = false;
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
            <cf-tool-call
              .call="${toolCall}"
              .result="${toolResult}"
            ></cf-tool-call>
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
            <cf-copy-button
              text="${textContent}"
              variant="ghost"
              size="sm"
              icon-only
            ></cf-copy-button>
          `
          : null}
      </div>
    `;
  }

  override firstUpdated(
    changedProperties: Map<string | number | symbol, unknown>,
  ) {
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
  }

  private _updateThemeProperties() {
    if (!this.theme) return;
    applyThemeToElement(this, this.theme);
  }

  override render() {
    const messageClass = `message message-${this.role}`;
    const textContent = this._extractTextContent();
    const variant = this.role === "user" ? "inverse" : "default";

    return html`
      <div class="message-wrapper">
        ${this._renderAvatar()}
        <div class="message-bubble">
          <div class="${messageClass}">
            <cf-markdown
              .content="${textContent}"
              .variant="${variant}"
              ?streaming="${this.streaming}"
              ?compact="${this.compact}"
            ></cf-markdown>
          </div>
          ${this._renderToolAttachments()} ${this._renderMessageActions()}
        </div>
      </div>
    `;
  }
}

globalThis.customElements.define("cf-chat-message", CFChatMessage);
