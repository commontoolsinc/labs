import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { provide } from "@lit/context";
import { BaseElement } from "../../core/base-element.ts";
import { type Cell } from "@commontools/runner";
import { createCellController } from "../../core/cell-controller.ts";
import "../ct-chat-message/ct-chat-message.ts";
import "../ct-tool-call/ct-tool-call.ts";
import type {
  BuiltInLLMMessage,
  BuiltInLLMToolCallPart,
  BuiltInLLMToolResultPart,
} from "@commontools/api";
import { 
  themeContext, 
  defaultTheme, 
  type CTTheme, 
  applyThemeToElement,
  getSemanticSpacing
} from "../theme-context.ts";

/**
 * CTChat - Chat container that handles message flow and tool call correlation
 *
 * @element ct-chat
 *
 * @prop {Cell<BuiltInLLMMessage[]>|BuiltInLLMMessage[]} messages - Messages array or Cell containing messages
 * @prop {boolean} pending - Show animated typing indicator for assistant response
 * @prop {CTTheme} theme - Theme configuration for chat components
 *
 * @example
 * <ct-chat .messages=${messagesCell} .pending=${true}></ct-chat>
 */
export class CTChat extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
      }

      .message-item {
        margin-bottom: var(--ct-spacing-1, 0.25rem);
      }

      .message-item.grouped {
        margin-bottom: var(--ct-spacing-1, 0.25rem);
      }

      .message-item.last-in-group {
        margin-bottom: var(--ct-spacing-4, 1rem);
      }

      .message-item.system {
        margin-bottom: var(--ct-spacing-4, 1rem);
      }

      .tool-attachments-only {
        display: flex;
        flex-direction: column;
        gap: var(--ct-spacing-1, 0.25rem);
        max-width: 70%;
        align-self: flex-start;
      }

      .pending-message {
        display: flex;
        align-items: flex-start;
        margin-bottom: var(--ct-theme-spacing-message-bottom, var(--ct-spacing-1, 0.25rem));
      }

      .pending-bubble {
        background-color: var(--ct-theme-surface, var(--ct-color-gray-100, #f3f4f6));
        color: var(--ct-theme-text-muted, var(--ct-color-gray-900, #111827));
        padding: var(--ct-theme-padding-bubble, var(--ct-spacing-3, 0.75rem)) var(--ct-theme-padding-bubble-horizontal, var(--ct-spacing-4, 1rem));
        border-radius: var(--ct-theme-border-radius, var(--ct-border-radius-lg, 0.5rem));
        border: 1px solid var(--ct-theme-border-muted, var(--ct-color-gray-200, #e5e7eb));
        max-width: 70%;
        display: flex;
        align-items: center;
        gap: var(--ct-theme-spacing-tight, var(--ct-spacing-1, 0.25rem));
      }

      .typing-dots {
        display: flex;
        gap: var(--ct-theme-spacing-tight, 4px);
      }

      .typing-dot {
        width: 8px;
        height: 8px;
        background-color: var(--ct-theme-text-muted, var(--ct-color-gray-400, #9ca3af));
        border-radius: 50%;
        animation: typingBounce 1.4s infinite ease-in-out;
      }

      .typing-dot:nth-child(1) {
        animation-delay: -0.32s;
      }

      .typing-dot:nth-child(2) {
        animation-delay: -0.16s;
      }

      @keyframes typingBounce {
        0%, 80%, 100% {
          opacity: 0.3;
          transform: scale(0.8);
        }
        40% {
          opacity: 1;
          transform: scale(1);
        }
      }
    `,
  ];

  /* ---------- Cell controller for messages binding ---------- */
  private _cellController = createCellController<BuiltInLLMMessage[]>(this, {
    timing: { strategy: "immediate" },
    onChange: () => {
      this.requestUpdate();
      // Emit event for parent scroll containers
      this.dispatchEvent(
        new CustomEvent("ct-chat-updated", {
          bubbles: true,
          composed: true,
        }),
      );
    },
  });

  @property({ type: Array })
  declare messages: Cell<BuiltInLLMMessage[]> | BuiltInLLMMessage[];

  @property({ type: Boolean, reflect: true })
  declare pending: boolean;

  @provide({ context: themeContext })
  @property({ type: Object })
  declare theme: CTTheme;

  constructor() {
    super();
    this.messages = [];
    this.pending = false;
    this.theme = defaultTheme;
  }

  private get _messagesArray(): readonly BuiltInLLMMessage[] {
    return this._cellController.getValue() || [];
  }

  override firstUpdated(changedProperties: Map<string, any>) {
    super.firstUpdated(changedProperties);
    // Initialize cell controller binding
    this._cellController.bind(this.messages);
    // Apply theme properties
    this._updateThemeProperties();
  }

  private _updateThemeProperties() {
    if (!this.theme) return;
    
    // Apply standard theme properties with custom spacing for chat-specific needs
    applyThemeToElement(this, this.theme, {
      additionalSpacing: {
        "message-bottom": getSemanticSpacing(this.theme.density, 'sm', 'tight'),
        "padding-bubble": getSemanticSpacing(this.theme.density, 'lg', 'normal'),
        "padding-bubble-horizontal": getSemanticSpacing(this.theme.density, 'xl', 'normal'),
      }
    });
  }

  override willUpdate(changedProperties: Map<string, any>) {
    super.willUpdate(changedProperties);
    // If the messages property itself changed (e.g., switched to a different cell)
    if (changedProperties.has("messages")) {
      // Bind the new messages (Cell or plain array) to the controller
      this._cellController.bind(this.messages);
    }
  }

  private _buildToolResultMap(): Map<string, BuiltInLLMToolResultPart> {
    const resultMap = new Map<string, BuiltInLLMToolResultPart>();

    this._messagesArray.forEach((message) => {
      if (message.role === "tool" && Array.isArray(message.content)) {
        message.content.forEach((part) => {
          if (part.type === "tool-result") {
            resultMap.set(part.toolCallId, part);
          }
        });
      }
    });

    return resultMap;
  }

  private _getMessageGroupClasses(messageIndex: number): string {
    const messages = this._messagesArray;
    const currentMessage = messages[messageIndex];
    const prevMessage = messages[messageIndex - 1];
    const nextMessage = messages[messageIndex + 1];

    const classes = ["message-item"];

    // System messages are never grouped
    if (currentMessage.role === "system") {
      classes.push("system");
      return classes.join(" ");
    }

    // Check if this message should be grouped with the previous one
    const shouldGroupWithPrev = prevMessage &&
      prevMessage.role !== "system" &&
      this._isSameGroup(prevMessage.role, currentMessage.role);

    // Check if this message should be grouped with the next one
    const shouldGroupWithNext = nextMessage &&
      nextMessage.role !== "system" &&
      this._isSameGroup(currentMessage.role, nextMessage.role);

    if (shouldGroupWithPrev || shouldGroupWithNext) {
      classes.push("grouped");
    }

    // Mark as last in group if not grouping with next message
    if (!shouldGroupWithNext) {
      classes.push("last-in-group");
    }

    return classes.join(" ");
  }

  private _isSameGroup(role1: string, role2: string): boolean {
    // User messages only group with other user messages
    if (role1 === "user") return role2 === "user";

    // Assistant and tool messages group together
    if (role1 === "assistant") return role2 === "assistant" || role2 === "tool";
    if (role1 === "tool") return role2 === "assistant" || role2 === "tool";

    return false;
  }

  private _renderMessage(
    message: BuiltInLLMMessage,
    toolResultMap: Map<string, BuiltInLLMToolResultPart>,
    messageIndex: number,
  ) {
    if (message.role === "tool") {
      // Don't render tool messages directly, they're handled as part of tool calls
      return null;
    }

    // For assistant messages with tool calls, we need to inject the results
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const toolCalls = message.content.filter(
        (part): part is BuiltInLLMToolCallPart => part.type === "tool-call",
      );
      const textParts = message.content.filter(
        (part) => part.type === "text",
      );

      if (toolCalls.length > 0) {
        // Create enhanced content with tool results
        const enhancedContent = [...message.content];

        toolCalls.forEach((toolCall) => {
          const result = toolResultMap.get(toolCall.toolCallId);
          if (result) {
            enhancedContent.push(result);
          }
        });

        // If there's no text content, render only the tool calls
        if (textParts.length === 0) {
          return html`
            <div class="${this._getMessageGroupClasses(messageIndex)}">
              <div class="tool-attachments-only">
                ${toolCalls.map((toolCall) => {
                  const toolResult = toolResultMap.get(toolCall.toolCallId);
                  return html`
                    <ct-tool-call
                      .call="${toolCall}"
                      .result="${toolResult}"
                    ></ct-tool-call>
                  `;
                })}
              </div>
            </div>
          `;
        }

        return html`
          <div class="${this._getMessageGroupClasses(messageIndex)}">
            <ct-chat-message
              .role="${message.role}"
              .content="${enhancedContent}"
            ></ct-chat-message>
          </div>
        `;
      }
    }

    return html`
      <div class="${this._getMessageGroupClasses(messageIndex)}">
        <ct-chat-message
          .role="${message.role}"
          .content="${message.content}"
        ></ct-chat-message>
      </div>
    `;
  }

  private _renderPendingMessage() {
    if (!this.pending) return null;

    return html`
      <div class="pending-message">
        <div class="pending-bubble">
          <div class="typing-dots">
            <div class="typing-dot"></div>
            <div class="typing-dot"></div>
            <div class="typing-dot"></div>
          </div>
        </div>
      </div>
    `;
  }

  override updated(changed: Map<string | number | symbol, unknown>) {
    super.updated(changed);

    // Update theme properties when theme changes
    if (changed.has("theme")) {
      this._updateThemeProperties();
    }

    // Emit event when pending state changes
    if (changed.has("pending")) {
      this.dispatchEvent(
        new CustomEvent("ct-chat-updated", {
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  override render() {
    const toolResultMap = this._buildToolResultMap();

    return html`
      ${this._messagesArray.map((message, index) =>
        this._renderMessage(message, toolResultMap, index)
      )} ${this._renderPendingMessage()}
    `;
  }
}

globalThis.customElements.define("ct-chat", CTChat);
