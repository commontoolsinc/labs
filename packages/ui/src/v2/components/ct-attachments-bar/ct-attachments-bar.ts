import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";
import "../ct-chip/ct-chip.ts";
import { isCellHandle } from "@commontools/runtime-client";

/**
 * Attachment data structure
 */
interface Attachment {
  id: string;
  name: string;
  type: "file" | "clipboard" | "mention";
  data?: any;
  charm?: any;
  removable?: boolean;
}

/**
 * CTAttachmentsBar - Display pinned cells as a horizontal list of chips
 *
 * @element ct-attachments-bar
 *
 * @attr {boolean} removable - Whether pinned cells can be removed (default: false)
 *
 * @prop {Attachment[]} pinnedCells - Array of pinned cells to display
 *
 * @fires ct-remove - Fired when a pinned cell is removed. detail: { id: string }
 * @fires ct-click - Fired when a pinned cell is clicked. detail: { id: string, attachment: Attachment }
 *
 * @example
 * <ct-attachments-bar .pinnedCells=${pinnedCells}></ct-attachments-bar>
 * <ct-attachments-bar .pinnedCells=${pinnedCells} removable></ct-attachments-bar>
 */
export class CTAttachmentsBar extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
      }

      .attachments-list {
        display: flex;
        flex-wrap: wrap;
        gap: var(--ct-theme-spacing-tight, var(--ct-spacing-1, 0.25rem));
        align-items: center;
      }

      .empty-state {
        color: var(
          --ct-theme-color-text-muted,
          var(--ct-color-gray-400, #9ca3af)
        );
        font-size: 0.8125rem;
      }
    `,
  ];

  @property({ type: Array })
  pinnedCells: Attachment[] = [];

  @property({ type: Boolean })
  removable = false;

  private _getVariant(type: string): "default" | "primary" | "accent" {
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

  private _getIcon(type: string): string {
    switch (type) {
      case "mention":
        return "@";
      case "file":
        return "📎";
      case "clipboard":
        return "📋";
      default:
        return "";
    }
  }

  private _handleRemove(id: string, e?: Event): void {
    e?.stopPropagation();
    this.emit("ct-remove", { id });
  }

  private _handleClick(id: string, attachment: Attachment): void {
    this.emit("ct-click", { id, attachment });
  }

  override render() {
    // TODO(runtime-worker-refactor): This component expects `Attachment[]`,
    // matching jsx.d.ts, BuiltInLLMDialogState response, but is receiving
    // a CellHandle (guessing of type Attachment[]).
    if (isCellHandle(this.pinnedCells)) {
      return html`
        <div class="empty-state">TODO(runtime-worker-refactor)</div>
      `;
    }
    if (!this.pinnedCells || this.pinnedCells.length === 0) {
      return html`
        <div class="empty-state">No pinned cells</div>
      `;
    }

    return html`
      <div class="attachments-list">
        ${this.pinnedCells.map(
          (attachment) =>
            html`
              <ct-chip
                variant="${this._getVariant(attachment.type)}"
                ?removable="${this.removable &&
                  (attachment.removable !== false)}"
                interactive
                @ct-remove="${(e: Event) =>
                  this._handleRemove(attachment.id, e)}"
                @ct-click="${() =>
                  this._handleClick(attachment.id, attachment)}"
              >
                ${attachment.name}
                <span slot="icon">${this._getIcon(attachment.type)}</span>
              </ct-chip>
            `,
        )}
      </div>
    `;
  }
}

customElements.define("ct-attachments-bar", CTAttachmentsBar);
