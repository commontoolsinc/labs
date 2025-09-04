import { css, html } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CTAutoLayout - Responsive multi-panel layout component
 *
 * Automatically arranges children:
 * - Desktop: Side-by-side columns
 * - Mobile: Tabbed interface
 *
 * @element ct-autolayout
 *
 * @example
 * <ct-autolayout tabNames={["Chat", "Tools", "Lists"]}>
 *   <div>Messages</div>
 *   <div>Calculator results</div>
 *   <div>Todo items</div>
 * </ct-autolayout>
 */
export class CTAutoLayout extends BaseElement {
  static override properties = {
    tabNames: { type: Array, attribute: false },
  };
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      box-sizing: border-box;
    }

    .tabs {
      display: none; /* Hidden by default (desktop) */
      border-top: 1px solid #e0e0e0;
      flex: none;
      order: 2; /* Move tabs to bottom */
    }

    .tab {
      padding: 0.75rem 1rem;
      border: none;
      background: none;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      font-size: 0.9rem;
    }

    .tab:hover {
      background: #f5f5f5;
    }

    .tab.active {
      border-bottom-color: #007acc;
      font-weight: 500;
    }

    .content {
      flex: 1;
      overflow: hidden;
      order: 1; /* Content comes first, tabs at bottom */
    }

    /* Desktop: Grid layout */
    @media (min-width: 769px) {
      .content {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
        gap: 1rem;
      }

      .tabs {
        display: none;
      }

      ::slotted(*) {
        height: 100%;
      }
    }

    /* Mobile: Tabbed layout */
    @media (max-width: 768px) {
      .tabs {
        display: flex;
      }

      /* Hide all children by default */
      ::slotted(*) {
        display: none;
        height: 100%;
      }

      /* Show only the active child */
      ::slotted(.active-tab) {
        display: flex !important;
        width: 100%;
        flex-direction: column;
      }
    }
  `;

  private _activeTab = 0;
  private _children: Element[] = [];

  declare tabNames: string[];

  constructor() {
    super();
    this.tabNames = [];
  }

  override connectedCallback() {
    super.connectedCallback();
    this._updateChildren();
    this._updateActiveTab();
  }

  private _updateChildren() {
    this._children = Array.from(this.children);
  }

  private _handleTabClick(index: number) {
    this._activeTab = index;
    this._updateActiveTab();
    this.requestUpdate();
  }

  private _updateActiveTab() {
    // Remove active-tab class from all children
    this._children.forEach(child => {
      child.classList.remove('active-tab');
    });

    // Add active-tab class to the current active child
    if (this._children[this._activeTab]) {
      this._children[this._activeTab].classList.add('active-tab');
    }
  }

  override render() {
    this._updateChildren();

    return html`
      <!-- Tabs (only visible on mobile) -->
      <div class="tabs">
        ${this.tabNames.map((name, index) => {
          return html`
            <button
              class="${classMap({ tab: true, active: index === this._activeTab })}"
              @click=${() => this._handleTabClick(index)}
            >
              ${name}
            </button>
          `;
        })}
      </div>

      <!-- Content area -->
      <div class="content">
        <slot></slot>
      </div>
    `;
  }
}

globalThis.customElements.define("ct-autolayout", CTAutoLayout);
