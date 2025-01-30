import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { base } from "../shared/styles.js";

interface TabItem {
  icon: string;
  label: string;
  id: string;
}

@customElement("os-tab-bar")
export class OsTabBar extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        display: block;
        background: var(--bg-2);
        padding: var(--gap-sm) 0;
      }

      .tab-container {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-start;
        gap: var(--gap-xsm);
        padding: 0 var(--gap-xsm);
        padding-right: 128px;
        position: relative;
      }

      .reserved-space {
        position: absolute;
        right: 0;
        top: 0;
        width: 128px;
        height: 100%;
        pointer-events: none;
      }

      .tab-item {
        display: flex;
        flex-direction: column;
        align-items: center;
        width: 64px;
        position: relative;
        z-index: 1;
      }

      .tab-button {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--gap-xs);
        padding: var(--gap-xs);
        border: none;
        background: none;
        cursor: pointer;
        color: var(--c-text-2);
        transition: color var(--dur-md) var(--ease-out);
        width: 48px;
        height: 48px;
        position: relative;
      }

      .tab-button[aria-selected="true"] {
        color: var(--accent);
      }

      .tab-button[aria-selected="true"] .tab-label {
        color: var(--accent);
        font-weight: bold;
      }

      .tab-button[aria-selected="true"]::before {
        content: "";
        position: absolute;
        background: var(--c-text-2);
        opacity: 0.1;
        border-radius: 8px;
        z-index: -1;
        width: 52px;
        height: 52px;
        left: -2px;
        top: -6px;
      }

      .tab-label {
        color: var(--c-text-2);
        font-weight: normal;
        text-transform: uppercase;
        font-family: var(--font-family);
        font-size: var(--xsm-size);
        line-height: var(--xsm-line);
        text-align: center;
      }
    `,
  ];

  @property({ type: Array }) items: TabItem[] = [];
  @property({ type: String }) selected = "";

  private handleTabClick(id: string, event: Event) {
    this.selected = id;
    this.dispatchEvent(
      new CustomEvent("tab-change", {
        detail: { selected: id },
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render() {
    return html`
      <div class="tab-container">
        <div class="reserved-space"></div>
        ${this.items.map(
          (item) => html`
            <div class="tab-item">
              <button
                class="tab-button"
                @click=${(e: Event) => this.handleTabClick(item.id, e)}
                aria-selected=${this.selected === item.id}
                aria-label=${item.label}
              >
                <os-icon
                  theme=${this.selected === item.id ? "primary" : "secondary"}
                  icon=${item.icon}
                ></os-icon>
                <span class="tab-label">${item.label}</span>
              </button>
            </div>
          `,
        )}
      </div>
    `;
  }
}
