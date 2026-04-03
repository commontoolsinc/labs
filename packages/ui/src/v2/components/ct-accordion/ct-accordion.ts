import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CTAccordion - Collapsible content panels
 *
 * @element ct-accordion
 *
 * @attr {string} type - "single" | "multiple" - Whether one or multiple panels can be open
 * @attr {string|string[]} value - Currently open panel(s)
 * @attr {boolean} collapsible - Allow closing all panels (for single type)
 *
 * @slot - Default slot for ct-accordion-item elements
 *
 * @fires ct-change - Fired on expand/collapse with detail: { value }
 *
 * @example
 * <ct-accordion type="single" collapsible>
 *   <ct-accordion-item value="item1">
 *     <div slot="trigger">Section 1</div>
 *     <div slot="content">Content 1</div>
 *   </ct-accordion-item>
 * </ct-accordion>
 */

export type AccordionType = "single" | "multiple";

export class CTAccordion extends BaseElement {
  static override properties = {
    type: { type: String },
    value: { type: String },
    collapsible: { type: Boolean },
  };
  static override styles = css`
    :host {
      display: block;
      width: 100%;
    }

    .accordion {
      display: flex;
      flex-direction: column;
      gap: var(--accordion-gap, 0);
    }

    /* Allow custom styling via CSS custom properties */
    :host {
      --accordion-gap: 0;
    }
  `;

  declare type: AccordionType;
  declare value: string | string[];
  declare collapsible: boolean;

  constructor() {
    super();
    this.type = "single";
    this.value = [];
    this.collapsible = false;
  }

  override connectedCallback() {
    super.connectedCallback();

    // Listen for item toggle events
    this.addEventListener(
      "ct-accordion-toggle",
      this.handleItemToggle as EventListener,
    );

    // Parse value from attribute if it's a string
    const valueAttr = this.getAttribute("value");
    if (valueAttr) {
      try {
        this.value = JSON.parse(valueAttr);
      } catch {
        this.value = valueAttr;
      }
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener(
      "ct-accordion-toggle",
      this.handleItemToggle as EventListener,
    );
  }

  override updated(changedProperties: Map<string | number | symbol, unknown>) {
    super.updated(changedProperties);

    if (changedProperties.has("value") || changedProperties.has("type")) {
      // Ensure value type matches accordion type
      if (this.type === "single" && Array.isArray(this.value)) {
        this.value = this.value[0] || "";
      }

      // Update item states
      this.updateItemStates();
    }
  }

  override render() {
    return html`
      <div class="accordion" part="base">
        <slot></slot>
      </div>
    `;
  }

  private handleItemToggle = (
    event: CustomEvent<{ value: string; expanded: boolean }>,
  ) => {
    const { value: itemValue, expanded } = event.detail;

    event.stopPropagation();

    let newValue: string | string[];

    if (this.type === "single") {
      if (expanded) {
        newValue = itemValue;
      } else {
        // Only allow closing if collapsible is true
        newValue = this.collapsible ? "" : itemValue;
      }
    } else {
      const currentValues = Array.isArray(this.value)
        ? this.value
        : [this.value].filter(Boolean);

      if (expanded) {
        newValue = [...currentValues, itemValue];
      } else {
        newValue = currentValues.filter((v) => v !== itemValue);
      }
    }

    this.value = newValue;

    // Emit change event
    this.emit("ct-change", {
      value: this.value,
      type: this.type,
    });
  };

  private updateItemStates(): void {
    const items = this.querySelectorAll("ct-accordion-item");
    const values = Array.isArray(this.value)
      ? this.value
      : [this.value].filter(Boolean);

    items.forEach((item) => {
      const itemValue = item.getAttribute("value");
      if (itemValue) {
        const isExpanded = values.includes(itemValue);
        if (isExpanded) {
          item.setAttribute("expanded", "");
        } else {
          item.removeAttribute("expanded");
        }
      }
    });
  }

  /**
   * Get all accordion items
   */
  get items(): NodeListOf<Element> {
    return this.querySelectorAll("ct-accordion-item");
  }

  /**
   * Expand all items (only works with type="multiple")
   */
  expandAll(): void {
    if (this.type === "multiple") {
      const items = this.querySelectorAll("ct-accordion-item");
      const values: string[] = [];
      items.forEach((item) => {
        const value = item.getAttribute("value");
        if (value && !item.hasAttribute("disabled")) {
          values.push(value);
        }
      });
      this.value = values;
    }
  }

  /**
   * Collapse all items
   */
  collapseAll(): void {
    this.value = this.type === "single" ? "" : [];
  }
}

globalThis.customElements.define("ct-accordion", CTAccordion);
