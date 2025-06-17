/**
 * @component ct-radio-group
 * @description Container for managing multiple radio buttons with keyboard navigation support
 *
 * @tag ct-radio-group
 *
 * @attribute {string} name - The name for all radio buttons in the group (required)
 * @attribute {string} value - The currently selected radio button value
 * @attribute {boolean} disabled - Whether all radio buttons in the group are disabled
 *
 * @event {CustomEvent} ct-change - Fired when the selected radio changes
 * @event-detail {Object} detail - Event detail object
 * @event-detail {string} detail.value - The value of the newly selected radio
 *
 * @slot default - Container for ct-radio elements
 *
 * @csspart group - The radio group container element
 *
 * @example
 * ```html
 * <!-- Basic radio group -->
 * <ct-radio-group name="size" value="medium">
 *   <ct-radio value="small">Small</ct-radio>
 *   <ct-radio value="medium">Medium</ct-radio>
 *   <ct-radio value="large">Large</ct-radio>
 * </ct-radio-group>
 *
 * <!-- Disabled radio group -->
 * <ct-radio-group name="options" disabled>
 *   <ct-radio value="option1">Option 1</ct-radio>
 *   <ct-radio value="option2">Option 2</ct-radio>
 * </ct-radio-group>
 *
 * <!-- Listen for changes -->
 * <script>
 *   const radioGroup = document.querySelector('ct-radio-group');
 *   radioGroup.addEventListener('ct-change', (e) => {
 *     console.log('Selected:', e.detail.value);
 *   });
 * </script>
 * ```
 *
 * @accessibility
 * - Uses role="radiogroup" for proper screen reader support
 * - Keyboard navigation with arrow keys (Up/Down, Left/Right)
 * - Manages focus and selection state for child radio buttons
 * - Automatically assigns group name to child radios if not specified
 *
 * @methods
 * - getValue() - Get the currently selected radio value
 * - setValue(value) - Set the selected radio by value
 * - clear() - Clear the selection
 */

import { css, html, PropertyValues, unsafeCSS } from "lit";
import { BaseElement } from "../../core/base-element.ts";
import { radioGroupStyles } from "./styles.ts";

export class CTRadioGroup extends BaseElement {
  static override styles = unsafeCSS(radioGroupStyles);

  static override properties = {
    name: { type: String },
    value: { type: String },
    disabled: { type: Boolean, reflect: true },
  };

  declare name: string;
  declare value: string;
  declare disabled: boolean;

  constructor() {
    super();
    this.name = "";
    this.value = "";
    this.disabled = false;
  }

  override connectedCallback() {
    super.connectedCallback();
    // Set ARIA attributes
    this.setAttribute("role", "radiogroup");

    // Add event listeners
    this.addEventListener("radio-click", this.handleRadioClick);
    this.addEventListener("keydown", this.handleKeydown);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    // Clean up event listeners
    this.removeEventListener("radio-click", this.handleRadioClick);
    this.removeEventListener("keydown", this.handleKeydown);
  }

  override firstUpdated() {
    this.updateRadioNames();
    this.updateRadioSelection();
    this.updateRadioDisabled();
  }

  override updated(changedProperties: PropertyValues) {
    if (changedProperties.has("name")) {
      this.updateRadioNames();
    }
    if (changedProperties.has("value")) {
      const oldValue = changedProperties.get("value") as string;
      this.updateRadioSelection();
      if (oldValue !== this.value) {
        this.emit("ct-change", { value: this.value });
      }
    }
    if (changedProperties.has("disabled")) {
      this.updateRadioDisabled();
    }
  }

  override render() {
    return html`
      <div class="radio-group" part="group">
        <slot @slotchange="${this.handleSlotChange}"></slot>
      </div>
    `;
  }

  private handleSlotChange = () => {
    this.updateRadioNames();
    this.updateRadioSelection();
    this.updateRadioDisabled();
  };

  private getRadios(): NodeListOf<Element> {
    return this.querySelectorAll("ct-radio");
  }

  private updateRadioNames(): void {
    if (!this.name) return;

    const radios = this.getRadios();
    radios.forEach((radio) => {
      if (!radio.hasAttribute("name")) {
        radio.setAttribute("name", this.name);
      }
    });
  }

  private updateRadioSelection(): void {
    const radios = this.getRadios();
    radios.forEach((radio) => {
      const radioValue = radio.getAttribute("value");
      if (radioValue === this.value) {
        radio.setAttribute("checked", "");
        (radio as any).checked = true;
      } else {
        radio.removeAttribute("checked");
        (radio as any).checked = false;
      }
    });
  }

  private updateRadioDisabled(): void {
    const radios = this.getRadios();
    radios.forEach((radio) => {
      if (this.disabled) {
        radio.setAttribute("disabled", "");
        (radio as any).disabled = true;
      } else if (!radio.hasAttribute("disabled")) {
        // Only enable if the radio itself doesn't have disabled attribute
        (radio as any).disabled = false;
      }
    });
  }

  private handleRadioClick = (event: Event): void => {
    const customEvent = event as CustomEvent;
    const radio = customEvent.detail.radio;

    if (radio && radio.getAttribute("value")) {
      this.value = radio.getAttribute("value");
    }
  };

  private handleKeydown = (event: KeyboardEvent): void => {
    const radios = Array.from(this.getRadios()) as HTMLElement[];
    const enabledRadios = radios.filter((radio) =>
      !radio.hasAttribute("disabled")
    );

    if (enabledRadios.length === 0) return;

    const currentIndex = enabledRadios.findIndex((radio) =>
      radio === document.activeElement
    );
    let nextIndex = currentIndex;

    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight":
        event.preventDefault();
        nextIndex = currentIndex === -1
          ? 0
          : (currentIndex + 1) % enabledRadios.length;
        break;
      case "ArrowUp":
      case "ArrowLeft":
        event.preventDefault();
        nextIndex = currentIndex === -1
          ? enabledRadios.length - 1
          : (currentIndex - 1 + enabledRadios.length) % enabledRadios.length;
        break;
      default:
        return;
    }

    // Focus and select the next radio
    const nextRadio = enabledRadios[nextIndex];
    if (nextRadio) {
      nextRadio.focus();
      // Trigger click to select the radio
      nextRadio.click();
    }
  };

  /**
   * Get the currently selected radio value
   */
  getValue(): string {
    return this.value;
  }

  /**
   * Set the selected radio by value
   */
  setValue(value: string): void {
    this.value = value;
  }

  /**
   * Clear the selection
   */
  clear(): void {
    this.value = "";
  }
}

globalThis.customElements.define("ct-radio-group", CTRadioGroup);
