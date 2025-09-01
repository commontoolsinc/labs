import { css, html, unsafeCSS } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { marked } from "marked";
import { BaseElement } from "../../core/base-element.ts";

interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

interface ToolResult {
  id: string;
  result: string;
}

interface Tool {
  name: string;
  description?: string;
  parameters?: Record<string, any>;
}

/**
 * CTChatMessage - Chat message component with markdown support
 *
 * @element ct-chat-message
 *
 * @attr {string} role - The role of the message sender ("user" | "assistant")
 * @attr {string} content - The message content (supports markdown)
 * @attr {object} tools - JSON string of tool definitions
 * @attr {object} toolCalls - JSON string of tool calls
 * @attr {object} toolResults - JSON string of tool results
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
        margin-bottom: var(--ct-spacing-2, 0.5rem);
      }

      .message-wrapper {
        display: flex;
        width: 100%;
      }

      :host([role="user"]) .message-wrapper {
        justify-content: flex-end;
      }

      :host([role="assistant"]) .message-wrapper {
        justify-content: flex-start;
      }

      .message {
        max-width: 70%;
        padding: var(--ct-spacing-3, 0.75rem) var(--ct-spacing-4, 1rem);
        border-radius: var(--ct-border-radius-lg, 0.5rem);
        word-wrap: break-word;
        position: relative;
        width: fit-content;
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

      /* Tool attachments */
      .tool-attachments {
        margin-top: var(--ct-spacing-2, 0.5rem);
        display: flex;
        flex-direction: column;
        gap: var(--ct-spacing-2, 0.5rem);
      }

      :host([role="user"]) .tool-attachments {
        align-items: flex-end;
      }

      :host([role="assistant"]) .tool-attachments {
        align-items: flex-start;
      }

      .tool-item {
        max-width: 70%;
        padding: var(--ct-spacing-2, 0.5rem) var(--ct-spacing-3, 0.75rem);
        border-radius: var(--ct-border-radius, 0.25rem);
        border: 1px solid var(--ct-color-gray-200, #e5e7eb);
        background-color: var(--ct-color-gray-50, #f9fafb);
        font-size: 0.875rem;
        color: var(--ct-color-gray-700, #374151);
      }

      .tool-call {
        border-left: 3px solid var(--ct-color-blue-400, #60a5fa);
      }

      .tool-result {
        border-left: 3px solid var(--ct-color-green-400, #4ade80);
      }

      .tool-header {
        font-weight: 600;
        margin-bottom: var(--ct-spacing-1, 0.25rem);
        display: flex;
        align-items: center;
        gap: var(--ct-spacing-2, 0.5rem);
      }

      .tool-icon {
        width: 16px;
        height: 16px;
        opacity: 0.7;
      }

      .tool-content {
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
        white-space: pre-wrap;
        word-break: break-word;
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

  static override properties = {
    role: { type: String, reflect: true },
    content: { type: String },
    streaming: { type: Boolean, reflect: true },
    tools: { type: String },
    toolCalls: { type: String },
    toolResults: { type: String },
  };

  declare role: "user" | "assistant";
  declare content: string;
  declare streaming: boolean;
  declare tools: string;
  declare toolCalls: string;
  declare toolResults: string;

  constructor() {
    super();
    this.role = "user";
    this.content = "";
    this.streaming = false;
    this.tools = "";
    this.toolCalls = "";
    this.toolResults = "";
  }

  private _parseJSON<T>(jsonString: string): T[] {
    if (!jsonString) return [];
    try {
      return JSON.parse(jsonString);
    } catch {
      return [];
    }
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
    const toolCalls = this.toolCalls as ToolCall[];
    const toolResults = this.toolResults as ToolResult[];
    const tools = this.tools as { [id: string]: Tool };

    if (!toolCalls && !toolResults || (toolCalls.length === 0 && toolResults.length === 0)) {
      return null;
    }

    return html`
      <div class="tool-attachments">
        ${toolCalls.map(
          (call) => html`
            <div class="tool-item tool-call">
              <div class="tool-header">
                <span class="tool-icon">🔧</span>
                <span>Tool Call: ${call.name}</span>
              </div>
              <pre class="tool-content">${JSON.stringify(call.arguments, null, 2)}</pre>
            </div>
          `
        )}
        ${toolResults.map(
          (result) => html`
            <div class="tool-item tool-result">
              <div class="tool-header">
                <span class="tool-icon">✓</span>
                <span>Tool Result</span>
              </div>
              <pre class="tool-content">${result.result}</pre>
            </div>
          `
        )}
      </div>
    `;
  }

  override render() {
    const messageClass = `message message-${this.role}${
      this.streaming ? " streaming" : ""
    }`;
    const renderedContent = this._renderMarkdown(this.content);

    return html`
      <div class="message-wrapper">
        <div class="${messageClass}">
          <div class="message-content">
            ${unsafeHTML(renderedContent)}
          </div>
        </div>
      </div>
      ${this._renderToolAttachments()}
    `;
  }
}

globalThis.customElements.define("ct-chat-message", CTChatMessage);
