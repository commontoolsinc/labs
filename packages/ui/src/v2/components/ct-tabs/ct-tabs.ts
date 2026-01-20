import { css, html } from "lit";
import { type CellHandle } from "@commontools/runtime-client";
import { BaseElement } from "../../core/base-element.ts";
import { createStringCellController } from "../../core/cell-controller.ts";
import type { CTTab } from "../ct-tab/ct-tab.ts";
import type { CTTabPanel } from "../ct-tab-panel/ct-tab-panel.ts";

/**
 * CTTabs - Container component that manages tab navigation and content panels
 *
 * @element ct-tabs
 *
 * @attr {string} value - Currently selected tab value (plain string)
 * @prop {CellHandle<string>|string} value - Selected tab value (supports Cell for two-way binding)
 * @attr {string} orientation - Tab orientation: "horizontal" | "vertical" (default: "horizontal")
 *
 * @slot - Default slot for ct-tab-list and ct-tab-panel elements
 *
 * @fires ct-change - Fired when selected tab changes with detail: { value, oldValue }
 *
 * @example Plain string value
 * <ct-tabs value="tab1">
 *   <ct-tab-list>
 *     <ct-tab value="tab1">Tab 1</ct-tab>
 *     <ct-tab value="tab2">Tab 2</ct-tab>
 *   </ct-tab-list>
 *   <ct-tab-panel value="tab1">Content 1</ct-tab-panel>
 *   <ct-tab-panel value="tab2">Content 2</ct-tab-panel>
 * </ct-tabs>
 *
 * @example With Cell binding ($value for two-way binding)
 * const activeTab = cell("tab1");
 * <ct-tabs $value={activeTab}>
 *   ...
 * </ct-tabs>
 */
export class CTTabs extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        width: 100%;
        min-height: 0;
        flex: 1;
      }

      .tabs {
        display: flex;
        flex-direction: column;
        width: 100%;
        flex: 1;
        min-height: 0;
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
    `,
  ];

  static override properties = {
    value: { attribute: false }, // Cell or string, not reflected as attribute
    orientation: { type: String },
  };

  declare value: CellHandle<string> | string;
  declare orientation: "horizontal" | "vertical";

  // Track last known value to detect external cell changes
  private _lastKnownValue: string = "";

  /* ---------- Cell controller for value binding ---------- */
  private _cellController = createStringCellController(this, {
    timing: { strategy: "immediate" }, // Tab changes should be immediate
    onChange: (newValue: string, oldValue: string) => {
      // Track this internal change so render() doesn't double-update
      this._lastKnownValue = newValue;

      // Update tab/panel selection when cell value changes
      this.updateTabSelection();

      // Emit change event
      this.emit("ct-change", { value: newValue, oldValue });
    },
  });

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

  override firstUpdated() {
    // Initialize cell controller binding
    this._cellController.bind(this.value);

    // Set up slotchange listener to handle dynamically added content
    const slot = this.shadowRoot?.querySelector("slot");
    if (slot) {
      slot.addEventListener("slotchange", this.handleSlotChange);
    }

    // Track initial value and initialize tab selection
    this._lastKnownValue = this._cellController.getValue();
    this.updateTabSelection();
  }

  override willUpdate(
    changedProperties: Map<string | number | symbol, unknown>,
  ) {
    super.willUpdate(changedProperties);

    // If the value property itself changed (e.g., switched to a different cell)
    if (changedProperties.has("value") || !this._cellController.hasCell()) {
      this._cellController.bind(this.value);
    }
  }

  override updated(changedProperties: Map<string | number | symbol, unknown>) {
    super.updated(changedProperties);

    // Always check if the cell value changed (handles both property changes
    // and external cell updates that trigger requestUpdate via sink)
    const currentValue = this._cellController.getValue();
    if (currentValue !== this._lastKnownValue) {
      this._lastKnownValue = currentValue;
      this.updateTabSelection();
    }
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

  private _pendingRetry: number | null = null;

  private updateTabSelection(): void {
    const tabs = this.getTabs();
    const panels = this.getTabPanels();
    const currentValue = this._cellController.getValue();

    // When tabs exist in DOM but the VDOM framework hasn't set their properties yet,
    // defer selection until the next frame when properties will be available.
    // This handles the timing gap between DOM element creation and property assignment.
    if (tabs.length > 0 && (tabs[0] as CTTab).value === undefined) {
      if (this._pendingRetry !== null) {
        cancelAnimationFrame(this._pendingRetry);
      }
      this._pendingRetry = requestAnimationFrame(() => {
        this._pendingRetry = null;
        this.updateTabSelection();
      });
      return;
    }

    // Track if any tab matches the current value
    let hasMatch = false;

    // Update tabs - use property access instead of getAttribute
    // because JSX sets properties, not attributes
    tabs.forEach((tab) => {
      const tabValue = (tab as CTTab).value;
      if (tabValue === currentValue) {
        hasMatch = true;
        tab.setAttribute("aria-selected", "true");
        tab.setAttribute("data-selected", "true");
        (tab as CTTab).selected = true;
      } else {
        tab.setAttribute("aria-selected", "false");
        tab.removeAttribute("data-selected");
        (tab as CTTab).selected = false;
      }
    });

    // Update panels - use property access instead of getAttribute
    // because JSX sets properties, not attributes
    panels.forEach((panel) => {
      const panelValue = (panel as CTTabPanel).value;
      if (panelValue === currentValue) {
        panel.removeAttribute("hidden");
        panel.setAttribute("data-selected", "true");
        (panel as CTTabPanel).hidden = false;
      } else {
        panel.setAttribute("hidden", "");
        panel.removeAttribute("data-selected");
        (panel as CTTabPanel).hidden = true;
      }
    });

    // If no tab matched the current value, default to first enabled tab
    if (!hasMatch && tabs.length > 0) {
      this.selectFirst();
    }
  }

  private handleSlotChange = () => {
    // Set up listener on ct-tab-list's internal slot when it appears.
    // ct-tab elements are nested inside ct-tab-list (not direct children of ct-tabs),
    // so we need to listen to the inner slot to detect when tabs are added.
    this.setupTabListSlotListener();

    this.updateTabSelection();
  };

  private _tabListSlotListenerSetup = false;

  /**
   * Sets up a slotchange listener on ct-tab-list's internal slot.
   * This is necessary because ct-tab elements are slotted into ct-tab-list,
   * not directly into ct-tabs. Without this listener, we wouldn't know when
   * tabs are actually added to the DOM.
   */
  private setupTabListSlotListener(): void {
    if (this._tabListSlotListenerSetup) return;

    const tabList = this.querySelector("ct-tab-list") as
      | (Element & { updateComplete?: Promise<boolean> })
      | null;
    if (!tabList) return;

    // Wait for ct-tab-list to have its shadow DOM ready
    const tabListSlot = tabList.shadowRoot?.querySelector("slot");
    if (!tabListSlot) {
      // ct-tab-list hasn't rendered yet, retry after it updates
      tabList.updateComplete?.then(() => {
        this.setupTabListSlotListener();
      });
      return;
    }

    this._tabListSlotListenerSetup = true;

    tabListSlot.addEventListener("slotchange", () => {
      this.updateTabSelection();
    });

    // Check if tabs are already present (slotchange may have already fired)
    if (tabListSlot.assignedElements().length > 0) {
      this.updateTabSelection();
    }
  }

  private handleTabClick = (event: CustomEvent<{ tab: Element }>) => {
    const tab = event.detail.tab as CTTab;

    // Use property access instead of getAttribute because JSX sets properties
    if (tab && tab.value && !tab.disabled) {
      const currentValue = this._cellController.getValue();

      if (currentValue !== tab.value) {
        // Use cell controller to set value - this handles both Cell and plain values
        // and triggers onChange callback which emits ct-change event
        this._cellController.setValue(tab.value);
      }
    }
  };

  private handleKeydown = (event: KeyboardEvent): void => {
    // Only handle keyboard navigation when focus is on a tab
    const target = event.target as HTMLElement;
    if (target.tagName !== "CT-TAB") return;

    const tabs = Array.from(this.getTabs()) as CTTab[];
    // Use property access instead of getAttribute because JSX sets properties
    const enabledTabs = tabs.filter((tab) => !tab.disabled);

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
    return this._cellController.getValue();
  }

  /**
   * Set the selected tab by value
   */
  setValue(value: string): void {
    this._cellController.setValue(value);
  }

  /**
   * Select the first tab
   */
  selectFirst(): void {
    const tabs = this.getTabs();
    // Use property access instead of getAttribute because JSX sets properties
    const firstEnabledTab = Array.from(tabs).find(
      (tab) => !(tab as CTTab).disabled,
    ) as CTTab | undefined;

    if (firstEnabledTab?.value) {
      this._cellController.setValue(firstEnabledTab.value);
    }
  }

  /**
   * Select the last tab
   */
  selectLast(): void {
    const tabs = this.getTabs();
    // Use property access instead of getAttribute because JSX sets properties
    const enabledTabs = Array.from(tabs).filter((tab) =>
      !(tab as CTTab).disabled
    ) as CTTab[];
    const lastTab = enabledTabs[enabledTabs.length - 1];
    if (lastTab?.value) {
      this._cellController.setValue(lastTab.value);
    }
  }
}

globalThis.customElements.define("ct-tabs", CTTabs);
