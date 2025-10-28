import { css, html, nothing, render } from "lit";
import { property } from "lit/decorators.js";
import { consume } from "@lit/context";
import { type Cell, NAME } from "@commontools/runner";
import { BaseElement } from "../../core/base-element.ts";
import {
  applyThemeToElement,
  type CTTheme,
  defaultTheme,
  themeContext,
} from "../theme-context.ts";
import {
  type Mentionable,
  type MentionableArray,
} from "../../core/mentionable.ts";
import { MentionController } from "../../core/mention-controller.ts";
import "../ct-button/ct-button.ts";
import "../ct-chip/ct-chip.ts";

/**
 * Attachment data structure
 */
export interface PromptAttachment {
  id: string; // UUID for reference
  name: string; // Display name
  type: "file" | "clipboard" | "mention";
  data?: File | Blob | string;
  charm?: Mentionable; // For mention-type attachments
}

/**
 * CTPromptInput - Enhanced textarea input component with @-mentions and attachments support
 * Based on ct-message-input but with multiline support and prompt-specific features
 *
 * @element ct-prompt-input
 *
 * @attr {string} placeholder - Placeholder text for the textarea
 * @attr {string} buttonText - Text for the send button (default: "Send")
 * @attr {boolean} disabled - Whether the textarea and button are disabled (prevents any action)
 * @attr {boolean} pending - Whether the component is in pending state (blocks editing, shows stop button)
 * @attr {string} value - Current textarea value
 * @attr {boolean} autoResize - Whether textarea auto-resizes to fit content (default: true)
 * @attr {number} rows - Initial number of rows for the textarea (default: 1)
 * @attr {number} maxRows - Maximum number of rows for auto-resize (default: 10)
 * @attr {Cell<MentionableArray>} mentionable - Array of mentionable items for @-mention autocomplete
 *
 * @fires ct-send - Fired when send button is clicked or Enter is pressed. detail: { text: string, attachments: PromptAttachment[], mentions: Mentionable[] }
 * @fires ct-stop - Fired when stop button is clicked during pending state
 * @fires ct-input - Fired when textarea value changes. detail: { value: string }
 * @fires ct-attachment-add - Fired when an attachment is added (mention accepted, file uploaded, etc). detail: { attachment: PromptAttachment }
 * @fires ct-attachment-remove - Fired when an attachment is removed from the composer. detail: { id: string }
 *
 * @example
 * <ct-prompt-input
 *   placeholder="Ask me anything..."
 *   button-text="Send"
 *   .mentionable=${mentionableCell}
 *   @ct-send="${(e) => console.log(e.detail.text, e.detail.mentions)}"
 * ></ct-prompt-input>
 */
export class CTPromptInput extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
        width: 100%;

        /* CSS variables for customization */
        --ct-prompt-input-gap: var(
          --ct-theme-spacing-normal,
          var(--ct-spacing-2, 0.5rem)
        );
        --ct-prompt-input-padding: var(
          --ct-theme-spacing-loose,
          var(--ct-spacing-3, 0.75rem)
        );
        --ct-prompt-input-border-radius: var(
          --ct-theme-border-radius,
          var(--ct-radius-md, 0.375rem)
        );
        --ct-prompt-input-border: var(
          --ct-theme-color-border,
          var(--ct-border-color, #e2e8f0)
        );
        --ct-prompt-input-background: var(
          --ct-theme-color-background,
          var(--ct-background, #ffffff)
        );
        --ct-prompt-input-min-height: 2.5rem;
        --ct-prompt-input-max-height: 12rem;
      }

      .container {
        position: relative;
        display: flex;
        flex-direction: column;
        gap: var(--ct-prompt-input-gap);
        padding: var(--ct-prompt-input-padding);
        background: var(--ct-prompt-input-background);
        border: 1px solid var(--ct-prompt-input-border);
        border-radius: var(--ct-prompt-input-border-radius);
        transition: all var(--ct-theme-animation-duration, 150ms)
          cubic-bezier(0.4, 0, 0.2, 1);
        }

        .container:focus-within {
          border-color: var(
            --ct-theme-color-primary,
            var(--ct-color-primary, #3b82f6)
          );
          box-shadow: 0 0 0 0.5px
            var(--ct-theme-color-primary, rgba(59, 130, 246, 0.1));
          }

          .input-row {
            display: flex;
            align-items: flex-end;
            gap: var(--ct-prompt-input-gap);
          }

          .textarea-wrapper {
            flex: 1;
            position: relative;
          }

          textarea {
            width: 100%;
            border: none;
            background: transparent;
            padding: 0;
            min-height: var(--ct-prompt-input-min-height);
            max-height: var(--ct-prompt-input-max-height);
            resize: none;
            font-family: var(--ct-theme-font-family, inherit);
            font-size: 0.875rem;
            line-height: 1.25rem;
            color: var(--ct-theme-color-text, var(--ct-color-gray-900, #111827));
            overflow-y: auto;
          }

          textarea:focus {
            outline: none;
          }

          textarea::placeholder {
            color: var(--ct-theme-color-text-muted, var(--ct-color-gray-400, #9ca3af));
          }

          .actions {
            display: flex;
            align-items: center;
            gap: var(--ct-theme-spacing-tight, var(--ct-spacing-1, 0.25rem));
            margin-bottom: 0.125rem; /* Slight adjustment for alignment */
          }

          ct-button {
            white-space: nowrap;
            min-width: auto;
            height: 2rem;
            padding: 0 0.75rem;
          }

          /* Pending state - blocks editing but allows stop */
          :host([pending]) textarea {
            opacity: 0.7;
            pointer-events: none;
          }

          /* Disabled state */
          :host([disabled]) .container {
            opacity: 0.5;
            cursor: not-allowed;
          }

          /* Size variants */
          :host([size="sm"]) {
            --ct-prompt-input-padding: var(
              --ct-theme-spacing-normal,
              var(--ct-spacing-2, 0.5rem)
            );
            --ct-prompt-input-min-height: 2rem;
          }

          :host([size="lg"]) {
            --ct-prompt-input-padding: var(
              --ct-theme-spacing-loose,
              var(--ct-spacing-4, 1rem)
            );
            --ct-prompt-input-min-height: 3rem;
          }

          /* Compact variant - minimal padding */
          :host([variant="compact"]) {
            --ct-prompt-input-padding: var(
              --ct-theme-spacing-normal,
              var(--ct-spacing-2, 0.5rem)
            );
            --ct-prompt-input-gap: var(
              --ct-theme-spacing-tight,
              var(--ct-spacing-1, 0.25rem)
            );
          }

          /* Pills list styles */
          .pills-list {
            display: flex;
            flex-wrap: wrap;
            gap: var(--ct-theme-spacing-tight, var(--ct-spacing-1, 0.25rem));
          }

          /* File upload styles */
          .upload-button {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 2rem;
            height: 2rem;
            border-radius: var(
              --ct-theme-border-radius,
              var(--ct-radius-md, 0.375rem)
            );
            cursor: pointer;
            transition: background-color 0.15s;
            color: var(--ct-theme-color-text-muted, var(--ct-color-gray-500, #6b7280));
          }

          .upload-button:hover {
            background: var(
              --ct-theme-surface,
              var(--ct-color-gray-100, #f3f4f6)
            );
            color: var(--ct-theme-color-text, var(--ct-color-gray-900, #111827));
          }

          input[type="file"] {
            display: none;
          }
        `,
      ];

      static override properties = {
        placeholder: { type: String },
        buttonText: { type: String, attribute: "button-text" },
        disabled: { type: Boolean, reflect: true },
        pending: { type: Boolean, reflect: true },
        value: { type: String },
        autoResize: { type: Boolean, attribute: "auto-resize" },
        rows: { type: Number },
        maxRows: { type: Number, attribute: "max-rows" },
        size: { type: String, reflect: true },
        variant: { type: String, reflect: true },
        theme: { type: Object, attribute: false },
        mentionable: { type: Object, attribute: false },
      };

      declare placeholder: string;
      declare buttonText: string;
      declare disabled: boolean;
      declare pending: boolean;
      declare value: string;
      declare autoResize: boolean;
      declare rows: number;
      declare maxRows: number;
      declare size: string;
      declare variant: string;
      declare mentionable: Cell<MentionableArray> | null;

      @consume({ context: themeContext, subscribe: true })
      @property({ attribute: false })
      declare theme?: CTTheme;

      private _textareaElement?: HTMLElement;

      // Attachment management
      private attachments: Map<string, PromptAttachment> = new Map();

      // Mention controller
      private mentionController = new MentionController(this, {
        onInsert: (markdown, mention) =>
          this._insertMentionAtCursor(markdown, mention),
        getCursorPosition: () => this._getCursorPosition(),
        getContent: () => this.value,
      });

      // Overlay management for mentions dropdown (rendered in body)
      private _mentionsOverlay: HTMLDivElement | null = null;
      private _resizeObs?: ResizeObserver;
      private _raf?: number;

      constructor() {
        super();
        this.placeholder = "";
        this.buttonText = "Send";
        this.disabled = false;
        this.pending = false;
        this.value = "";
        this.autoResize = true;
        this.rows = 1;
        this.maxRows = 10;
        this.size = "";
        this.variant = "";
        this.mentionable = null;
      }

      override connectedCallback(): void {
        super.connectedCallback();
        this._resizeObs = new ResizeObserver(() =>
          this._repositionMentionsOverlay()
        );
        this._resizeObs.observe(this);
        globalThis.addEventListener("resize", this._onWindowChange, {
          passive: true,
        });
        globalThis.addEventListener("scroll", this._onWindowChange, true);
      }

      override disconnectedCallback(): void {
        super.disconnectedCallback();
        this._resizeObs?.disconnect();
        this._resizeObs = undefined;
        globalThis.removeEventListener("resize", this._onWindowChange);
        globalThis.removeEventListener("scroll", this._onWindowChange, true);
        this._unmountMentionsOverlay();
      }

      private _onWindowChange = () => {
        if (!this.mentionController.isShowing) return;
        this._repositionMentionsOverlay();
      };

      override firstUpdated(
        changedProperties: Map<string | number | symbol, unknown>,
      ) {
        super.firstUpdated(changedProperties);
        this._textareaElement = this.shadowRoot?.querySelector(
          "textarea",
        ) as HTMLTextAreaElement;
        this._updateThemeProperties();
      }

      override updated(
        changedProperties: Map<string | number | symbol, unknown>,
      ) {
        super.updated(changedProperties);
        if (changedProperties.has("theme")) {
          this._updateThemeProperties();
          // Update theme on overlay if it exists
          if (this._mentionsOverlay) {
            applyThemeToElement(
              this._mentionsOverlay,
              this.theme || defaultTheme,
            );
          }
        }
        if (changedProperties.has("mentionable")) {
          this.mentionController.setMentionable(this.mentionable);
        }

        // Manage mentions overlay based on controller state
        // The MentionController will trigger requestUpdate when state changes
        if (this.mentionController.isShowing) {
          this._mountMentionsOverlay();
          this._renderMentionsOverlay();
          this._positionMentionsOverlay();
        } else {
          this._unmountMentionsOverlay();
        }
      }

      private _updateThemeProperties() {
        const currentTheme = this.theme || defaultTheme;
        applyThemeToElement(this, currentTheme);
      }

      private _handleSend(event?: Event) {
        event?.preventDefault();

        if (this.disabled || this.pending) return;

        const textarea = this._textareaElement as any;
        if (!textarea || !textarea.value?.trim()) return;

        const text = textarea.value;

        // Get all attachments and derive mentions from mention attachments
        const attachments = Array.from(this.attachments.values());
        const mentions = attachments
          .filter((a) => a.type === "mention" && a.charm)
          .map((a) => a.charm as Mentionable);

        // Clear the textarea and attachments
        textarea.value = "";
        this.value = "";
        this.attachments.clear();

        // Emit the send event with new structure
        this.emit("ct-send", {
          text,
          attachments,
          mentions,
          // Backward compatibility
          message: text,
        });
      }

      private _handleStop(event?: Event) {
        event?.preventDefault();

        if (this.disabled) return;

        // Emit the stop event
        this.emit("ct-stop");
      }

      private _handleKeyDown(event: KeyboardEvent) {
        // Don't handle shortcuts if disabled or pending
        if (this.disabled || this.pending) return;

        // Let mention controller handle keyboard events first
        if (this.mentionController.handleKeyDown(event)) {
          return;
        }

        // Enter without Shift sends the message
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          this._handleSend();
          return;
        }

        // Shift+Enter adds new line (default textarea behavior)
        // Ctrl/Cmd+Enter also sends (alternative shortcut)
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          this._handleSend();
          return;
        }
      }

      private _handleInput(event: Event) {
        const textarea = event.target as HTMLTextAreaElement;
        this.value = textarea.value;

        // Auto-resize textarea if enabled
        if (this.autoResize) {
          textarea.style.height = "auto";
          textarea.style.height = `${
            Math.min(
              textarea.scrollHeight,
              parseFloat(
                getComputedStyle(this).getPropertyValue(
                  "--ct-prompt-input-max-height",
                ) || "12rem",
              ) * 16,
            )
          }px`;
        }

        // Let mention controller handle input changes
        this.mentionController.handleInput(event);

        // Emit input event for external listeners
        this.emit("ct-input", { value: this.value });
      }

      /**
       * Handle paste event for large content detection
       */
      private _handlePaste(event: ClipboardEvent) {
        const clipboardData = event.clipboardData;
        if (!clipboardData) return;

        // Check for files in clipboard
        const files = Array.from(clipboardData.files);
        if (files.length > 0) {
          event.preventDefault();

          for (const file of files) {
            const id = this._generateAttachmentId();
            const attachment: PromptAttachment = {
              id,
              name: file.name || "Pasted file",
              type: "clipboard",
              data: file,
            };

            this.addAttachment(attachment);
          }

          return;
        }

        // Check for large text content (>1000 chars)
        const text = clipboardData.getData("text");
        if (text && text.length > 1000) {
          event.preventDefault();

          const id = this._generateAttachmentId();
          const attachment: PromptAttachment = {
            id,
            name: `Pasted content (${text.length} chars)`,
            type: "clipboard",
            data: text,
          };

          this.addAttachment(attachment);

          // Insert reference to the attachment in the text
          const textarea = this._textareaElement as HTMLTextAreaElement;
          const cursorPos = textarea.selectionStart;
          const beforeCursor = this.value.substring(0, cursorPos);
          const afterCursor = this.value.substring(textarea.selectionEnd);

          const reference = `[${attachment.name}](#${id})`;
          this.value = beforeCursor + reference + afterCursor;
          textarea.value = this.value;

          // Set cursor after the reference
          const newCursorPos = beforeCursor.length + reference.length;
          textarea.setSelectionRange(newCursorPos, newCursorPos);

          this.requestUpdate();
        }
      }

      /**
       * Get current cursor position in the textarea
       */
      private _getCursorPosition(): number {
        const textarea = this._textareaElement as HTMLTextAreaElement;
        return textarea?.selectionStart ?? 0;
      }

      /**
       * Insert mention at cursor position
       */
      private _insertMentionAtCursor(
        _markdown: string,
        mention: Mentionable,
      ): void {
        const textarea = this._textareaElement as HTMLTextAreaElement;
        if (!textarea) return;

        const cursorPos = textarea.selectionStart;
        const textBeforeCursor = this.value.substring(0, cursorPos);
        const lastAtIndex = textBeforeCursor.lastIndexOf("@");

        if (lastAtIndex === -1) return;

        const beforeMention = this.value.substring(0, lastAtIndex);
        const afterMention = this.value.substring(cursorPos);

        // Format the name: add brackets if it contains spaces
        const name = mention[NAME] || "Unknown";
        const formattedName = name.includes(" ") ? `[${name}]` : name;

        this.value = beforeMention + formattedName + afterMention;
        textarea.value = this.value;

        // Create an attachment pill for the mention
        const attachmentId = this._generateAttachmentId();
        const attachment: PromptAttachment = {
          id: attachmentId,
          name,
          type: "mention",
          charm: mention,
        };

        this.addAttachment(attachment);

        // Set cursor after the inserted mention
        const newCursorPos = beforeMention.length + formattedName.length;
        textarea.setSelectionRange(newCursorPos, newCursorPos);
        textarea.focus();

        this.requestUpdate();
      }

      override render() {
        return html`
          <div style="position: relative;">
            <div class="container">
              ${this._renderPillsList()}

              <div class="input-row">
                <div class="textarea-wrapper">
                  <textarea
                    placeholder="${this.placeholder}"
                    .value="${this.value}"
                    rows="${this.rows}"
                    ?disabled="${this.disabled}"
                    spellcheck="true"
                    @input="${this._handleInput}"
                    @keydown="${this._handleKeyDown}"
                    @paste="${this._handlePaste}"
                    part="textarea"
                  ></textarea>
                  <!-- Mentions dropdown now rendered in body via overlay -->
                </div>

                <div class="actions">
                  <!-- Hidden file input -->
                  <input
                    type="file"
                    multiple
                    @change="${this._handleFileSelect}"
                  />

                  <!-- Upload button -->
                  ${!this.pending
                    ? html`
                      <div
                        class="upload-button"
                        @click="${this._handleUploadClick}"
                        role="button"
                        aria-label="Upload file"
                        title="Upload file"
                      >
                        📎
                      </div>
                    `
                    : ""} ${this.pending
                    ? html`
                      <ct-button
                        id="ct-prompt-input-stop-button"
                        variant="secondary"
                        size="${this.size === "sm"
                          ? "sm"
                          : this.size === "lg"
                          ? "lg"
                          : "md"}"
                        ?disabled="${this.disabled}"
                        @click="${this._handleStop}"
                        part="stop-button"
                      >
                        Stop
                      </ct-button>
                    `
                    : html`
                      <ct-button
                        id="ct-prompt-input-send-button"
                        variant="primary"
                        size="${this.size === "sm"
                          ? "sm"
                          : this.size === "lg"
                          ? "lg"
                          : "md"}"
                        ?disabled="${this.disabled || !this.value?.trim()}"
                        @click="${this._handleSend}"
                        part="send-button"
                      >
                        ${this.buttonText}
                      </ct-button>
                    `}
                </div>
              </div>
            </div>
          </div>
        `;
      }

      /**
       * Generate a unique ID for attachments
       */
      private _generateAttachmentId(): string {
        return `attachment-${Date.now()}-${
          Math.random().toString(36).substring(2, 9)
        }`;
      }

      /**
       * Add an attachment
       */
      addAttachment(attachment: PromptAttachment): void {
        this.attachments.set(attachment.id, attachment);
        this.emit("ct-attachment-add", { attachment });
        this.requestUpdate();
      }

      /**
       * Remove an attachment by ID
       */
      removeAttachment(id: string): void {
        this.attachments.delete(id);
        this.emit("ct-attachment-remove", { id });
        this.requestUpdate();
      }

      /**
       * Get icon for attachment type
       */
      private _getAttachmentIcon(type: PromptAttachment["type"]): string {
        switch (type) {
          case "mention":
            return "@";
          case "file":
            return "📎";
          case "clipboard":
            return "📋";
          default:
            return "📄";
        }
      }

      private _getAttachmentVariant(
        type: PromptAttachment["type"],
      ): "default" | "primary" | "accent" {
        switch (type) {
          case "mention":
            return "primary";
          case "clipboard":
            return "accent";
          case "file":
          default:
            return "default";
        }
      }

      /**
       * Render pills list for attachments
       */
      private _renderPillsList() {
        if (this.attachments.size === 0) {
          return "";
        }

        const attachmentsArray = Array.from(this.attachments.values());

        return html`
          <div class="pills-list">
            ${attachmentsArray.map((attachment) =>
              html`
                <ct-chip
                  variant="${this._getAttachmentVariant(attachment.type)}"
                  removable
                  @ct-remove="${() => this.removeAttachment(attachment.id)}"
                >
                  ${attachment.name}
                  <span slot="icon">${this._getAttachmentIcon(
                    attachment.type,
                  )}</span>
                </ct-chip>
              `
            )}
          </div>
        `;
      }

      /**
       * Handle file upload button click
       */
      private _handleUploadClick() {
        const fileInput = this.shadowRoot?.querySelector(
          'input[type="file"]',
        ) as HTMLInputElement;
        fileInput?.click();
      }

      /**
       * Handle file selection
       */
      private _handleFileSelect(event: Event) {
        const input = event.target as HTMLInputElement;
        const files = input.files;

        if (!files || files.length === 0) return;

        for (const file of Array.from(files)) {
          const id = this._generateAttachmentId();
          const attachment: PromptAttachment = {
            id,
            name: file.name,
            type: "file",
            data: file,
          };

          this.addAttachment(attachment);
        }

        // Reset the input so the same file can be selected again
        input.value = "";
      }

      /**
       * Mount the mentions overlay in the document body
       */
      private _mountMentionsOverlay() {
        if (this._mentionsOverlay) return;
        const el = document.createElement("div");
        el.style.position = "fixed";
        el.style.inset = "0 auto auto 0";
        el.style.zIndex = "1000";
        el.style.pointerEvents = "auto";
        el.dataset.ctPromptInputMentionsOverlay = "";
        document.body.appendChild(el);
        this._mentionsOverlay = el;
        applyThemeToElement(el, this.theme ?? defaultTheme);
      }

      /**
       * Unmount the mentions overlay from the document body
       */
      private _unmountMentionsOverlay() {
        if (this._mentionsOverlay) {
          render(nothing, this._mentionsOverlay);
          this._mentionsOverlay.remove();
          this._mentionsOverlay = null;
        }
        if (this._raf) cancelAnimationFrame(this._raf);
        this._raf = undefined;
      }

      /**
       * Render the mentions dropdown into the overlay
       */
      private _renderMentionsOverlay() {
        if (!this._mentionsOverlay) return;

        const filteredMentions = this.mentionController.getFilteredMentions();

        if (filteredMentions.length === 0) {
          this._unmountMentionsOverlay();
          return;
        }

        // Inline styles so overlay has its own styling
        const tpl = html`
          <style>
          .mentions-dropdown {
            position: absolute;
            background: var(--ct-theme-color-surface, #fff);
            border: 1px solid var(--ct-theme-color-border, #e5e7eb);
            border-radius: var(--ct-theme-border-radius, 0.375rem);
            box-shadow: var(--ct-shadow-md, 0 10px 15px -3px rgba(0,0,0,0.1),
              0 4px 6px -2px rgba(0,0,0,0.05));
            max-height: 200px;
            overflow-y: auto;
            min-width: 200px;
            pointer-events: auto;
          }
          .mention-item {
            padding: 0.5rem 0.75rem;
            cursor: pointer;
            border-bottom: 1px solid var(--ct-theme-color-border, #e5e7eb);
            transition: background-color 0.1s;
          }
          .mention-item:last-child {
            border-bottom: none;
          }
          .mention-item:hover,
          .mention-item.selected {
            background-color: var(--ct-theme-surface, #f3f4f6);
          }
          .mention-name {
            font-weight: 500;
            color: var(--ct-theme-color-text, #111827);
          }
          </style>
          <div class="mentions-dropdown" role="listbox">
            ${filteredMentions.map((mention, index) =>
              html`
                <div
                  class="mention-item ${index ===
                      this.mentionController.state.selectedIndex
                    ? "selected"
                    : ""}"
                  role="option"
                  @click="${() =>
                    this.mentionController.insertMention(mention)}"
                  @mouseenter="${() =>
                    this.mentionController.selectMention(index)}"
                >
                  <div class="mention-name">${mention[NAME]}</div>
                </div>
              `
            )}
          </div>
        `;
        render(tpl, this._mentionsOverlay);
      }

      /**
       * Position the mentions overlay relative to the textarea
       */
      private _positionMentionsOverlay() {
        if (!this._mentionsOverlay) return;
        const dropdown = this._mentionsOverlay.querySelector(
          ".mentions-dropdown",
        ) as HTMLElement | null;
        if (!dropdown) return;

        const textarea = this._textareaElement as HTMLTextAreaElement;
        if (!textarea) return;

        const rect = textarea.getBoundingClientRect();
        // Start below the textarea
        let top = rect.bottom + 2;
        let left = rect.left;

        // Temporarily set position for measurement
        dropdown.style.top = `${Math.round(top)}px`;
        dropdown.style.left = `${Math.round(left)}px`;
        dropdown.style.right = "auto";
        dropdown.style.bottom = "auto";

        // Next frame, measure and adjust to viewport
        if (this._raf) cancelAnimationFrame(this._raf);
        this._raf = requestAnimationFrame(() => {
          const vw = globalThis.innerWidth;
          const vh = globalThis.innerHeight;
          const dr = dropdown.getBoundingClientRect();

          // Horizontal clamping
          if (dr.right > vw - 8) {
            left = Math.max(8, vw - dr.width - 8);
          }
          if (left < 8) left = 8;

          // Vertical flip if overflow bottom
          if (dr.bottom > vh - 8) {
            const above = rect.top - dr.height - 2;
            if (above >= 8) top = above; // place above if space
            else top = Math.max(8, vh - dr.height - 8); // clamp
          }

          dropdown.style.top = `${Math.round(top)}px`;
          dropdown.style.left = `${Math.round(left)}px`;
        });
      }

      /**
       * Reposition the mentions overlay (for resize/scroll)
       */
      private _repositionMentionsOverlay() {
        this._positionMentionsOverlay();
      }

      /**
       * Focus the textarea programmatically
       */
      override focus(): void {
        (this._textareaElement as any)?.focus?.();
      }

      /**
       * Clear the textarea value
       */
      clear(): void {
        const textarea = this._textareaElement as any;
        if (textarea) {
          textarea.value = "";
          this.value = "";
        }
      }

      /**
       * Check if the input has content
       */
      get hasContent(): boolean {
        return !!this.value?.trim();
      }
    }

    globalThis.customElements.define("ct-prompt-input", CTPromptInput);
