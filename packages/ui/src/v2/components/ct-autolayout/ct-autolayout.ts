import { css, html } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CTAutoLayout - Responsive multi-panel layout component
 *
 * Automatically arranges children:
 * - Desktop: Optional left/right sidebars and center content grid
 * - Mobile: Degrades to a tabbed interface (left | content | right)
 *
 * @element ct-autolayout
 *
 * @example
 * <ct-autolayout tabNames={["Chat", "Tools", "Lists"]}>
 *   <div>Messages</div>
 *   <div>Calculator results</div>
 *   <div>Todo items</div>
 * </ct-autolayout>
 *
 * @example With sidebars
 * <ct-autolayout
 *   tabNames={["Chat", "Tools"]}
 *   leftTabName="Outline"
 *   rightTabName="Details"
 * >
 *   <aside slot="left">Outline here</aside>
 *   <div>Chat</div>
 *   <div>Tools</div>
 *   <aside slot="right">Extra details</aside>
 * </ct-autolayout>
 */
export class CTAutoLayout extends BaseElement {
  static override properties = {
    tabNames: { type: Array, attribute: false },
    leftTabName: { type: String, attribute: false },
    rightTabName: { type: String, attribute: false },
  };
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      box-sizing: border-box;
    }

    .controls {
      display: none; /* desktop-only */
      padding: 0.25rem 0.5rem;
      gap: 0.5rem;
      border-bottom: 1px solid #e0e0e0;
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

    .layout {
      flex: 1;
      overflow: hidden;
      order: 1; /* Content comes first, tabs at bottom */
      display: grid;
      grid-template-columns: 0px 1fr 0px; /* toggled by classes below */
      gap: 1rem;
    }

    .sidebar-left,
    .sidebar-right,
    .content {
      min-height: 0;
      min-width: 0;
    }

    .sidebar-left,
    .sidebar-right {
      overflow: hidden;
    }

    /* Indicate presence of sidebars; width controlled by -open flags */
    .has-left {
      grid-template-columns: 0px 1fr 0px;
    }
    .has-right {
      grid-template-columns: 0px 1fr 0px;
    }
    .left-open {
      grid-template-columns: 280px 1fr 0px;
    }
    .right-open {
      grid-template-columns: 0px 1fr 280px;
    }
    .left-open.right-open {
      grid-template-columns: 280px 1fr 280px;
    }

    /* Desktop: Grid layout */
    @media (min-width: 769px) {
      .controls {
        display: flex;
        justify-content: flex-end;
        align-items: center;
      }
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

      /* Collapse to single pane; hide wrappers by default */
      .layout {
        display: block;
      }
      .sidebar-left,
      .sidebar-right,
      .content {
        display: none;
        width: 100%;
        height: 100%;
      }

      .layout.active-left .sidebar-left,
      .layout.active-right .sidebar-right,
      .layout.active-content .content {
        display: block;
      }

      /* Hide all slotted children by default */
      ::slotted(*) {
        display: none;
        height: 100%;
      }

      /* Show only the active child inside content */
      .layout.active-content ::slotted(.active-tab) {
        display: flex !important;
        width: 100%;
        flex-direction: column;
      }
    }
  `;

  private _activeTab = 0;
  private _children: Element[] = [];
  private _leftEl: Element | null = null;
  private _rightEl: Element | null = null;
  private _hasLeft = false;
  private _hasRight = false;
  private _leftOpen = true;
  private _rightOpen = true;

  declare tabNames: string[];
  declare leftTabName?: string;
  declare rightTabName?: string;

  constructor() {
    super();
    this.tabNames = [];
    this.leftTabName = "Left";
    this.rightTabName = "Right";
  }

  override connectedCallback() {
    super.connectedCallback();
    this._updateChildren();
    this._updateActiveTab();
  }

  private _updateChildren() {
    this._children = Array.from(this.children);
    this._leftEl = this._children.find((el) => el.getAttribute("slot") ===
      "left") ?? null;
    this._rightEl = this._children.find((el) => el.getAttribute("slot") ===
      "right") ?? null;
    this._hasLeft = !!this._leftEl;
    this._hasRight = !!this._rightEl;
  }

  private _handleTabClick(index: number) {
    this._activeTab = index;
    this._updateActiveTab();
    this.requestUpdate();
  }

  private _toggleLeft() {
    if (!this._hasLeft) return;
    this._leftOpen = !this._leftOpen;
    this.requestUpdate();
  }

  private _toggleRight() {
    if (!this._hasRight) return;
    this._rightOpen = !this._rightOpen;
    this.requestUpdate();
  }

  private _updateActiveTab() {
    // Determine panes in order: left | defaults | right
    const defaults = this._children.filter((el) => !el.getAttribute("slot"));
    const panes: Element[] = [];
    if (this._leftEl) panes.push(this._leftEl);
    panes.push(...defaults);
    if (this._rightEl) panes.push(this._rightEl);

    // Remove active-tab class from all children
    this._children.forEach((child) => child.classList.remove("active-tab"));

    // Add active-tab class to current pane
    const active = panes[this._activeTab];
    if (active) active.classList.add("active-tab");
  }

  override render() {
    this._updateChildren();

    // Build tabs list: left | defaults | right
    const defaults = this._children.filter((el) => !el.getAttribute("slot"));
    const tabs: string[] = [];
    if (this._hasLeft) tabs.push(this.leftTabName || "Left");
    const defaultNames = this.tabNames.length === defaults.length
      ? this.tabNames
      : defaults.map((_, i) => `Pane ${i + 1}`);
    tabs.push(...defaultNames);
    if (this._hasRight) tabs.push(this.rightTabName || "Right");

    const layoutClass = classMap({
      layout: true,
      "has-left": this._hasLeft,
      "has-right": this._hasRight,
      "left-open": this._hasLeft && this._leftOpen,
      "right-open": this._hasRight && this._rightOpen,
      "active-left": this._activeTab === 0 && this._hasLeft,
      "active-right": this._activeTab === (tabs.length - 1) && this._hasRight,
      "active-content": !((this._activeTab === 0 && this._hasLeft) ||
        (this._activeTab === (tabs.length - 1) && this._hasRight)),
    });

    return html`
      <!-- Sidebar toggle controls (desktop only) -->
      <div class="controls" part="controls">
        ${this._hasLeft
          ? html`<button @click=${() => this._toggleLeft()} title="Toggle left">
              ${this._leftOpen ? "Hide Left" : "Show Left"}
            </button>`
          : null}
        ${this._hasRight
          ? html`<button @click=${() => this._toggleRight()} title="Toggle right">
              ${this._rightOpen ? "Hide Right" : "Show Right"}
            </button>`
          : null}
      </div>

      <!-- Tabs (only visible on mobile) -->
      <div class="tabs">
        ${tabs.map((name, index) => html`
          <button
            class="${classMap({ tab: true, active: index === this._activeTab })}"
            @click="${() => this._handleTabClick(index)}"
          >${name}</button>
        `)}
      </div>

      <!-- Grid layout: left | content | right -->
      <div class="${layoutClass}">
        <div class="sidebar-left">
          <slot name="left"></slot>
        </div>
        <div class="content">
          <slot></slot>
        </div>
        <div class="sidebar-right">
          <slot name="right"></slot>
        </div>
      </div>
    `;
  }
}

globalThis.customElements.define("ct-autolayout", CTAutoLayout);
