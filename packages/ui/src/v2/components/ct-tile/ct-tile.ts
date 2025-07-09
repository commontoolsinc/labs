import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CTTile - A tile component for rendering page/item previews with click handling
 *
 * @element ct-tile
 *
 * @attr {Object} item - Item object with title and metadata
 * @attr {string} summary - Summary text to display
 * @attr {boolean} clickable - Whether the tile is clickable
 *
 * @fires ct-click - Fired when tile is clicked with detail: { item }
 *
 * @example
 * <ct-tile .item="${page}" summary="Pages: 2, Lists: 1" @ct-click="${handleClick}"></ct-tile>
 */

export class CTTile extends BaseElement {
  @property()
  item: { title: string; [key: string]: any } = { title: "" };

  @property()
  summary: string = "";

  @property()
  clickable: boolean = true;

  static override styles = css`
    :host {
      display: block;
      width: 100%;

      --background: #ffffff;
      --foreground: #0f172a;
      --border: #e2e8f0;
      --ring: #94a3b8;
      --muted: #f8fafc;
      --muted-foreground: #64748b;
      --accent: #3b82f6;
      --accent-foreground: #ffffff;

      --tile-padding: 1rem;
      --tile-border-radius: 0.5rem;
      --tile-border: 1px solid var(--border);
      --tile-shadow:
        0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1);
    }

    .tile {
      background-color: var(--background);
      border: var(--tile-border);
      border-radius: var(--tile-border-radius);
      padding: var(--tile-padding);
      box-shadow: var(--tile-shadow);
      transition: all 0.2s;
      cursor: default;
    }

    .tile.clickable {
      cursor: pointer;
    }

    .tile.clickable:hover {
      border-color: var(--accent);
      box-shadow:
        0 4px 6px -1px rgb(0 0 0 / 0.1),
        0 2px 4px -2px rgb(0 0 0 / 0.1);
      transform: translateY(-1px);
    }

    .tile.clickable:active {
      transform: translateY(0);
      box-shadow: var(--tile-shadow);
    }

    .tile-title {
      font-weight: bold;
      font-size: 1.125rem;
      color: var(--foreground);
      margin: 0 0 0.5rem 0;
      line-height: 1.25;
    }

    .tile-summary {
      color: var(--muted-foreground);
      font-size: 0.875rem;
      line-height: 1.25;
      margin: 0;
    }

    .tile-content {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .summary-details {
      border: none;
      background: none;
      padding: 0;
      color: inherit;
      font: inherit;
      cursor: pointer;
    }

    .summary-details summary {
      cursor: pointer;
      user-select: none;
      color: var(--muted-foreground);
      font-size: 0.875rem;
    }

    .summary-details summary:hover {
      color: var(--foreground);
    }

    .summary-details[open] summary {
      margin-bottom: 0.5rem;
    }

    .empty-tile {
      color: var(--muted-foreground);
      font-style: italic;
      text-align: center;
      padding: 2rem;
    }
  `;

  private handleClick() {
    if (this.clickable) {
      this.emit("ct-click", { item: this.item });
    }
  }

  override render() {
    if (!this.item || !this.item.title) {
      return html`
        <div class="empty-tile">No item data</div>
      `;
    }

    return html`
      <div
        class="tile ${this.clickable ? "clickable" : ""}"
        @click="${this.handleClick}"
      >
        <div class="tile-content">
          <h3 class="tile-title">${this.item.title}</h3>
          ${this.summary
        ? html`
          <details class="summary-details">
            <summary>${this.summary}</summary>
          </details>
        `
        : ""}
          <slot></slot>
        </div>
      </div>
    `;
  }
}

globalThis.customElements.define("ct-tile", CTTile);
