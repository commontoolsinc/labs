import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CTTabs - Container component that manages tab navigation and content panels
 *
 * @element ct-tabs
 *
 * @attr {string} value - Currently selected tab value
 * @attr {string} orientation - Tab orientation: "horizontal" | "vertical" (default: "horizontal")
 *
 * @slot - Default slot for ct-tab-list and ct-tab-panel elements
 *
 * @fires ct-change - Fired when selected tab changes with detail: { value }
 *
 * @example
 * <ct-tabs value="tab1">
 *   <ct-tab-list>
 *     <ct-tab value="tab1">Tab 1</ct-tab>
 *     <ct-tab value="tab2">Tab 2</ct-tab>
 *   </ct-tab-list>
 *   <ct-tab-panel value="tab1">Content 1</ct-tab-panel>
 *   <ct-tab-panel value="tab2">Content 2</ct-tab-panel>
 * </ct-tabs>
 */
export class CTTabs extends BaseElement {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
    }

    .tabs {
      display: flex;
      flex-direction: column;
      width: 100%;
    }

    .tabs[data-orientation="horizontal"] {
      flex-direction: column;
    }

    .tabs[data-orientation="vertical"] {
      flex-direction: row;
    }

    /* Ensure proper layout for slotted content */
    ::slotted(ct-tab-list) {
      flex-shrink: 0;
    }

    ::slotted(ct-tab-panel) {
      flex: 1;
    }

    /* Handle vertical orientation */
    .tabs[data-orientation="vertical"] ::slotted(ct-tab-list) {
      flex-direction: column;
      height: 100%;
    }

    /* Ensure panels are properly hidden */
    ::slotted(ct-tab-panel[hidden]) {
      display: none !important;
    }
  `;

  static override properties = {
    value: { type: String },
    orientation: { type: String },
  };

  declare value: string;
  declare orientation: "horizontal" | "vertical";

  constructor() {
    super();
    this.value = "";
    this.orientation = "horizontal";
  }

  override connectedCallback() {
    super.connectedCallback();

    // Set ARIA attributes
    this.setAttribute("role", "tablist");

    // Add event listeners
    this.addEventListener("tab-click", this.handleTabClick as EventListener);
    this.addEventListener("keydown", this.handleKeydown);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("tab-click", this.handleTabClick as EventListener);
    this.removeEventListener("keydown", this.handleKeydown);
  }

  override updated(changedProperties: Map<string | number | symbol, unknown>) {
    super.updated(changedProperties);

    if (changedProperties.has("value")) {
      this.updateTabSelection();
    }
  }

  override firstUpdated() {
    // Initialize tabs
    this.updateTabSelection();
  }

  override render() {
    return html`
      <div class="tabs" part="tabs" data-orientation="${this.orientation}">
        <slot></slot>
      </div>
    `;
  }

  private getTabs(): NodeListOf<Element> {
    return this.querySelectorAll("ct-tab");
  }

  private getTabPanels(): NodeListOf<Element> {
    return this.querySelectorAll("ct-tab-panel");
  }

  private updateTabSelection(): void {
    const tabs = this.getTabs();
    const panels = this.getTabPanels();

    // Update tabs
    tabs.forEach((tab) => {
      const tabValue = tab.getAttribute("value");
      if (tabValue === this.value) {
        tab.setAttribute("aria-selected", "true");
        tab.setAttribute("data-selected", "true");
        (tab as any).selected = true;
      } else {
        tab.setAttribute("aria-selected", "false");
        tab.removeAttribute("data-selected");
        (tab as any).selected = false;
      }
    });

    // Update panels
    panels.forEach((panel) => {
      const panelValue = panel.getAttribute("value");
      if (panelValue === this.value) {
        panel.removeAttribute("hidden");
        panel.setAttribute("data-selected", "true");
        (panel as any).hidden = false;
      } else {
        panel.setAttribute("hidden", "");
        panel.removeAttribute("data-selected");
        (panel as any).hidden = true;
      }
    });
  }

  private handleTabClick = (event: CustomEvent<{ tab: Element }>) => {
    const tab = event.detail.tab;

    if (tab && tab.getAttribute("value") && !tab.hasAttribute("disabled")) {
      const oldValue = this.value;
      this.value = tab.getAttribute("value") || "";

      if (oldValue !== this.value) {
        this.emit("ct-change", { value: this.value });
      }
    }
  };

  private handleKeydown = (event: KeyboardEvent): void => {
    // Only handle keyboard navigation when focus is on a tab
    const target = event.target as HTMLElement;
    if (target.tagName !== "CT-TAB") return;

    const tabs = Array.from(this.getTabs()) as HTMLElement[];
    const enabledTabs = tabs.filter((tab) => !tab.hasAttribute("disabled"));

    if (enabledTabs.length === 0) return;

    const currentIndex = enabledTabs.findIndex((tab) => tab === target);
    let nextIndex = currentIndex;

    const isHorizontal = this.orientation === "horizontal";
    const nextKey = isHorizontal ? "ArrowRight" : "ArrowDown";
    const prevKey = isHorizontal ? "ArrowLeft" : "ArrowUp";

    switch (event.key) {
      case nextKey:
        event.preventDefault();
        nextIndex = currentIndex === -1
          ? 0
          : (currentIndex + 1) % enabledTabs.length;
        break;
      case prevKey:
        event.preventDefault();
        nextIndex = currentIndex === -1
          ? enabledTabs.length - 1
          : (currentIndex - 1 + enabledTabs.length) % enabledTabs.length;
        break;
      case "Home":
        event.preventDefault();
        nextIndex = 0;
        break;
      case "End":
        event.preventDefault();
        nextIndex = enabledTabs.length - 1;
        break;
      default:
        return;
    }

    // Focus and select the next tab
    const nextTab = enabledTabs[nextIndex];
    if (nextTab) {
      nextTab.focus();
      // Trigger click to select the tab
      nextTab.click();
    }
  };

  /**
   * Get the currently selected tab value
   */
  getValue(): string {
    return this.value;
  }

  /**
   * Set the selected tab by value
   */
  setValue(value: string): void {
    this.value = value;
  }

  /**
   * Select the first tab
   */
  selectFirst(): void {
    const tabs = this.getTabs();
    const firstEnabledTab = Array.from(tabs).find((tab) =>
      !tab.hasAttribute("disabled")
    );
    if (firstEnabledTab) {
      const value = firstEnabledTab.getAttribute("value");
      if (value) this.value = value;
    }
  }

  /**
   * Select the last tab
   */
  selectLast(): void {
    const tabs = this.getTabs();
    const enabledTabs = Array.from(tabs).filter((tab) =>
      !tab.hasAttribute("disabled")
    );
    const lastTab = enabledTabs[enabledTabs.length - 1];
    if (lastTab) {
      const value = lastTab.getAttribute("value");
      if (value) this.value = value;
    }
  }
}

globalThis.customElements.define("ct-tabs", CTTabs);
