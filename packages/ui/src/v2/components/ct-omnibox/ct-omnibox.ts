import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";
import { createCellController } from "../../core/cell-controller.ts";
import type { Cell } from "@commontools/runner";
import type { BuiltInLLMMessage } from "@commontools/api";
import type { MentionableArray } from "../../core/mentionable.ts";
import "../ct-prompt-input/index.ts";

/**
 * The omnibox container for the expanded FAB state.
 * Contains the prompt input and will contain history/peek in Phase 2.
 *
 * @element ct-omnibox
 *
 * @attr {boolean} pending - Whether a request is in progress
 *
 * @fires ct-send - Forwarded from ct-prompt-input
 * @fires ct-stop - Forwarded from ct-prompt-input
 * @fires ct-attachment-add - Forwarded from ct-prompt-input
 * @fires ct-attachment-remove - Forwarded from ct-prompt-input
 * @fires ct-input - Forwarded from ct-prompt-input
 */
export class CTOmnibox extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        box-sizing: border-box;
        width: 100%;
        height: 100%;
        overflow: hidden;
      }

      *,
      *::before,
      *::after {
        box-sizing: inherit;
      }

      .omnibox-container {
        display: flex;
        flex-direction: column;
        width: 100%;
        height: 100%;
        padding: 16px;
        gap: 12px;
      }

      /* Phase 2: Will contain peek, history, and composer sections */
      .composer-section {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-height: 0;
      }

      ct-prompt-input {
        width: 100%;
      }
    `,
  ];

  static override properties = {
    messages: { type: Object, attribute: false },
    pending: { type: Boolean },
    mentionable: { type: Object, attribute: false },
  };

  /**
   * Messages array or Cell (prepared for Phase 2 ct-chat integration)
   */
  @property({ type: Object, attribute: false })
  declare messages: Cell<BuiltInLLMMessage[]> | BuiltInLLMMessage[];

  /**
   * Whether a request is in progress
   */
  @property({ type: Boolean })
  declare pending: boolean;

  /**
   * Mentionable items for @-mentions
   */
  @property({ type: Object, attribute: false })
  declare mentionable: Cell<MentionableArray> | null;

  private _cellController = createCellController<BuiltInLLMMessage[]>(this, {
    timing: { strategy: "immediate" },
    onChange: () => {
      this.requestUpdate();
    },
  });

  constructor() {
    super();
    this.messages = [];
    this.pending = false;
    this.mentionable = null;
  }

  override willUpdate(changedProperties: Map<string, unknown>) {
    super.willUpdate(changedProperties);

    if (changedProperties.has("messages")) {
      this._cellController.bind(this.messages);
    }
  }

  private _handleSend = (e: CustomEvent) => {
    // Forward the event to parent
    this.emit("ct-send", e.detail);
  };

  private _handleStop = (e: CustomEvent) => {
    this.emit("ct-stop", e.detail);
  };

  private _handleAttachmentAdd = (e: CustomEvent) => {
    this.emit("ct-attachment-add", e.detail);
  };

  private _handleAttachmentRemove = (e: CustomEvent) => {
    this.emit("ct-attachment-remove", e.detail);
  };

  private _handleInput = (e: CustomEvent) => {
    this.emit("ct-input", e.detail);
  };

  override render() {
    return html`
      <div class="omnibox-container">
        <!-- Phase 2: Notification peek will go here -->

        <!-- Phase 2: History panel will go here -->

        <!-- Composer section -->
        <div class="composer-section">
          <ct-prompt-input
            placeholder="Type a message..."
            ?pending="${this.pending}"
            .mentionable="${this.mentionable}"
            @ct-send="${this._handleSend}"
            @ct-stop="${this._handleStop}"
            @ct-attachment-add="${this._handleAttachmentAdd}"
            @ct-attachment-remove="${this._handleAttachmentRemove}"
            @ct-input="${this._handleInput}"
          ></ct-prompt-input>
        </div>
      </div>
    `;
  }
}

if (!globalThis.customElements.get("ct-omnibox")) {
  globalThis.customElements.define("ct-omnibox", CTOmnibox);
}
