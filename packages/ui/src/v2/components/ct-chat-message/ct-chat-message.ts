import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { consume } from "@lit/context";
import { BaseElement } from "../../core/base-element.ts";
import "../ct-tool-call/ct-tool-call.ts";
import "../ct-button/ct-button.ts";
import "../ct-copy-button/ct-copy-button.ts";
import "../ct-markdown/ct-markdown.ts";
import type {
  BuiltInLLMContent,
  BuiltInLLMTextPart,
  BuiltInLLMToolCallPart,
  BuiltInLLMToolResultPart,
} from "@commontools/api";
import {
  applyThemeToElement,
  type CTTheme,
  themeContext,
} from "../theme-context.ts";

/**
 * CTChatMessage - Chat message component with markdown support
 *
 * @element ct-chat-message
 *
 * @attr {string} role - The role of the message sender ("user" | "assistant")
 * @attr {string|array} content - The message content (supports markdown and structured content)
 * @attr {string} avatar - Avatar URL for the message sender
 * @attr {string} name - Display name for the message sender
 * @attr {boolean} compact - Hides the copy button and collapses spacing around the message
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
        font-family: var(
          --ct-theme-font-family,
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
        background-color: var(
          --ct-theme-color-accent,
          var(--ct-color-blue-500, #3b82f6)
        );
        color: var(
          --ct-theme-color-accent-foreground,
          var(--ct-color-white, #ffffff)
        );
      }

      :host([role="assistant"]) .message {
        background-color: var(
          --ct-theme-color-surface,
          var(--ct-color-gray-100, #f3f4f6)
        );
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

      .message-user {
        background-color: var(--ct-theme-color-primary, #3b82f6);
        color: var(--ct-theme-color-primary-foreground, #ffffff);
      }

      .message-assistant {
        color: var(--ct-theme-color-text, #111827);
      }

      /* ct-markdown inherits color from parent */
      ct-markdown {
        color: inherit;
        line-height: 1.5;
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

      /* Compact mode styles */
      :host([compact]) .message {
        padding: var(--ct-theme-padding-compact, var(--ct-spacing-2, 0.5rem));
      }

      :host([compact]) .message-actions {
        display: none;
      }

      :host([compact]) .message-avatar {
        margin-right: var(--ct-theme-spacing-compact, var(--ct-spacing-1, 0.25rem));
      }

      :host([compact][role="user"]) .message-avatar {
        margin-right: 0;
        margin-left: var(--ct-theme-spacing-compact, var(--ct-spacing-1, 0.25rem));
      }

      :host([compact]) .tool-attachments {
        margin-top: var(--ct-theme-spacing-compact, var(--ct-spacing-1, 0.25rem));
        gap: var(--ct-theme-spacing-compact, var(--ct-spacing-1, 0.25rem));
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

  @consume({ context: themeContext, subscribe: true })
  @property({ attribute: false })
  declare theme?: CTTheme;

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
      (part): part is BuiltInLLMToolCallPart =>
        part != null && part.type === "tool-call",
    );
    const toolResults = contentArray.filter(
      (part): part is BuiltInLLMToolResultPart =>
        part != null && part.type === "tool-result",
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
        (part): part is BuiltInLLMTextPart =>
          part != null && part.type === "text",
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
            <ct-copy-button
              text="${textContent}"
              variant="ghost"
              size="sm"
              icon-only
            ></ct-copy-button>
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
            <ct-markdown
              .content="${textContent}"
              .variant="${variant}"
              ?streaming="${this.streaming}"
              ?compact="${this.compact}"
            ></ct-markdown>
          </div>
          ${this._renderToolAttachments()} ${this._renderMessageActions()}
        </div>
      </div>
    `;
  }
}

globalThis.customElements.define("ct-chat-message", CTChatMessage);
