import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";

export type SliderOrientation = "horizontal" | "vertical";

/**
 * CTSlider - Range input slider for value selection
 *
 * @element ct-slider
 *
 * @attr {number} value - Current slider value
 * @attr {number} min - Minimum allowed value (default: 0)
 * @attr {number} max - Maximum allowed value (default: 100)
 * @attr {number} step - Value increment/decrement step (default: 1)
 * @attr {boolean} disabled - Whether the slider is disabled
 * @attr {SliderOrientation} orientation - Slider orientation ("horizontal" | "vertical")
 *
 * @fires ct-change - Fired when value changes with detail: { value, oldValue }
 * @fires ct-input - Fired during dragging with detail: { value, oldValue }
 *
 * @example
 * <ct-slider min="0" max="100" value="50"></ct-slider>
 * <ct-slider min="0" max="100" value="25" step="5"></ct-slider>
 * <ct-slider orientation="vertical" style="height: 200px"></ct-slider>
 */

export class CTSlider extends BaseElement {
  static override properties = {
    value: { type: Number },
    min: { type: Number },
    max: { type: Number },
    step: { type: Number },
    disabled: { type: Boolean, reflect: true },
    orientation: { type: String, reflect: true },
  };
  static override styles = css`
    :host {
      display: inline-block;
      width: 100%;
      min-width: 200px;

      /* Default color values if not provided */
      --background: #ffffff;
      --foreground: #0f172a;
      --border: #e2e8f0;
      --ring: #94a3b8;
      --primary: #3b82f6;
      --primary-foreground: #ffffff;
      --muted: #f8fafc;
      --muted-foreground: #64748b;

      /* Slider dimensions */
      --slider-height: 1.25rem;
      --track-height: 0.5rem;
      --thumb-size: 1.25rem;
      --slider-border-radius: 9999px;
    }

    :host([orientation="vertical"]) {
      width: var(--slider-height);
      height: 200px;
      min-width: var(--slider-height);
      min-height: 200px;
    }

    * {
      box-sizing: border-box;
    }

    .slider {
      position: relative;
      width: 100%;
      height: var(--slider-height);
      display: flex;
      align-items: center;
      touch-action: none;
      user-select: none;
    }

    .slider.vertical {
      width: var(--slider-height);
      height: 100%;
      align-items: center;
      justify-content: center;
    }

    .slider.disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    /* Track */
    .track {
      position: relative;
      width: 100%;
      height: var(--track-height);
      background-color: var(--border);
      border-radius: var(--slider-border-radius);
      overflow: hidden;
      cursor: pointer;
    }

    .slider.vertical .track {
      width: var(--track-height);
      height: 100%;
    }

    .slider.disabled .track {
      cursor: not-allowed;
    }

    /* Range (filled portion) */
    .range {
      position: absolute;
      height: 100%;
      background-color: var(--primary);
      border-radius: var(--slider-border-radius);
      pointer-events: none;
    }

    .slider.horizontal .range {
      left: 0;
      top: 0;
    }

    .slider.vertical .range {
      bottom: 0;
      left: 0;
      width: 100%;
    }

    /* Thumb */
    .thumb {
      position: absolute;
      width: var(--thumb-size);
      height: var(--thumb-size);
      background-color: var(--background);
      border: 2px solid var(--primary);
      border-radius: var(--slider-border-radius);
      cursor: grab;
      transform: translate(-50%, -50%);
      transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);
      box-shadow:
        0 1px 3px 0 rgba(0, 0, 0, 0.1),
        0 1px 2px -1px rgba(0, 0, 0, 0.1);
    }

    .slider.horizontal .thumb {
      top: 50%;
    }

    .slider.vertical .thumb {
      left: 50%;
      transform: translate(-50%, 50%);
    }

    .slider.disabled .thumb {
      cursor: not-allowed;
      border-color: var(--border);
    }

    /* Hover state */
    :host(:not([disabled]):hover) .thumb {
      border-color: var(--primary);
      box-shadow:
        0 4px 6px -1px rgba(0, 0, 0, 0.1),
        0 2px 4px -2px rgba(0, 0, 0, 0.1);
    }

    /* Focus state */
    :host(:focus) {
      outline: none;
    }

    :host(:focus-visible) .thumb {
      outline: 2px solid transparent;
      outline-offset: 2px;
      box-shadow: 0 0 0 2px var(--background), 0 0 0 4px var(--ring);
    }

    /* Active/dragging state */
    :host(.dragging) .thumb,
    .thumb:active {
      cursor: grabbing;
      transform: translate(-50%, -50%) scale(1.1);
    }

    .slider.vertical .thumb:active,
    :host(.dragging) .slider.vertical .thumb {
      transform: translate(-50%, 50%) scale(1.1);
    }

    /* Touch target enhancement */
    .thumb::before {
      content: "";
      position: absolute;
      top: 50%;
      left: 50%;
      width: 2.5rem;
      height: 2.5rem;
      transform: translate(-50%, -50%);
    }

    /* Transitions */
    .range {
      transition: width 150ms cubic-bezier(0.4, 0, 0.2, 1);
    }

    .slider.vertical .range {
      transition: height 150ms cubic-bezier(0.4, 0, 0.2, 1);
    }

    /* Smooth thumb movement during drag */
    :host(.dragging) .thumb {
      transition: transform 150ms cubic-bezier(0.4, 0, 0.2, 1);
    }

    /* High contrast mode support */
    @media (prefers-contrast: high) {
      .track {
        border: 1px solid;
      }

      .thumb {
        border-width: 3px;
      }
    }

    /* Reduced motion support */
    @media (prefers-reduced-motion: reduce) {
      .thumb,
      .range {
        transition: none;
      }
    }

    /* Dark mode support (when CSS variables are updated) */
    @media (prefers-color-scheme: dark) {
      :host {
        --background: #0f172a;
        --foreground: #f8fafc;
        --border: #334155;
        --ring: #64748b;
        --primary: #60a5fa;
        --primary-foreground: #0f172a;
        --muted: #1e293b;
        --muted-foreground: #94a3b8;
      }
    }
  `;

  declare value: number;
  declare min: number;
  declare max: number;
  declare step: number;
  declare disabled: boolean;
  declare orientation: SliderOrientation;

  private _trackElement: HTMLElement | null = null;
  private _thumbElement: HTMLElement | null = null;
  private _rangeElement: HTMLElement | null = null;

  constructor() {
    super();
    this.value = 50;
    this.min = 0;
    this.max = 100;
    this.step = 1;
    this.disabled = false;
    this.orientation = "horizontal";
  }

  get trackElement(): HTMLElement | null {
    if (!this._trackElement) {
      this._trackElement =
        this.shadowRoot?.querySelector(".track") as HTMLElement || null;
    }
    return this._trackElement;
  }

  get thumbElement(): HTMLElement | null {
    if (!this._thumbElement) {
      this._thumbElement =
        this.shadowRoot?.querySelector(".thumb") as HTMLElement || null;
    }
    return this._thumbElement;
  }

  get rangeElement(): HTMLElement | null {
    if (!this._rangeElement) {
      this._rangeElement =
        this.shadowRoot?.querySelector(".range") as HTMLElement || null;
    }
    return this._rangeElement;
  }

  private _isDragging = false;

  override connectedCallback() {
    super.connectedCallback();

    // Ensure value is within bounds and snapped to step
    this.value = this._snapToStep(this._clampValue(this.value));

    // Set up ARIA attributes
    this.setAttribute("role", "slider");
    this.tabIndex = this.disabled ? -1 : 0;
    this._updateAriaAttributes();

    // Add keyboard event listener
    this.addEventListener("keydown", this._handleKeyDown);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("keydown", this._handleKeyDown);

    // Remove document listeners if dragging
    if (this._isDragging) {
      this._stopDragging();
    }
  }

  override updated(changedProperties: Map<string | number | symbol, unknown>) {
    super.updated(changedProperties);

    if (changedProperties.has("disabled")) {
      this.tabIndex = this.disabled ? -1 : 0;
    }

    if (
      changedProperties.has("min") || changedProperties.has("max") ||
      changedProperties.has("step")
    ) {
      // Re-clamp and snap the value when constraints change
      const clampedValue = this._snapToStep(this._clampValue(this.value));
      if (clampedValue !== this.value) {
        this.value = clampedValue;
      }
    }

    if (
      changedProperties.has("value") || changedProperties.has("min") ||
      changedProperties.has("max") || changedProperties.has("disabled") ||
      changedProperties.has("orientation")
    ) {
      this._updateAriaAttributes();
      this._updateSliderPosition();
    }
  }

  override firstUpdated() {
    // Cache references
    this._trackElement =
      this.shadowRoot?.querySelector(".track") as HTMLElement || null;
    this._thumbElement =
      this.shadowRoot?.querySelector(".thumb") as HTMLElement || null;
    this._rangeElement =
      this.shadowRoot?.querySelector(".range") as HTMLElement || null;

    this._updateSliderPosition();
  }

  override render() {
    const sliderClasses = {
      "slider": true,
      [this.orientation]: true,
      "disabled": this.disabled,
    };

    const classString = Object.entries(sliderClasses)
      .filter(([_, value]) => value)
      .map(([key]) => key)
      .join(" ");

    return html`
      <div class="${classString}" part="base">
        <div
          class="track"
          part="track"
          @mousedown="${this._handleTrackMouseDown}"
          @touchstart="${this._handleTrackTouchStart}"
        >
          <div class="range" part="range"></div>
          <div
            class="thumb"
            part="thumb"
            role="presentation"
            @mousedown="${this._handleThumbMouseDown}"
            @touchstart="${this._handleThumbTouchStart}"
          >
          </div>
        </div>
      </div>
    `;
  }

  private _clampValue(value: number): number {
    return Math.min(Math.max(value, this.min), this.max);
  }

  private _snapToStep(value: number): number {
    const steps = Math.round((value - this.min) / this.step);
    return this.min + steps * this.step;
  }

  private _getPercentage(): number {
    const range = this.max - this.min;
    return range > 0 ? ((this.value - this.min) / range) * 100 : 0;
  }

  private _updateSliderPosition(): void {
    if (!this.thumbElement || !this.rangeElement) return;

    const percentage = this._getPercentage();

    if (this.orientation === "horizontal") {
      this.thumbElement.style.left = `${percentage}%`;
      this.thumbElement.style.top = "";
      this.rangeElement.style.width = `${percentage}%`;
      this.rangeElement.style.height = "";
    } else {
      // For vertical sliders, 0% is at the bottom
      this.thumbElement.style.bottom = `${percentage}%`;
      this.thumbElement.style.left = "";
      this.thumbElement.style.top = "";
      this.rangeElement.style.height = `${percentage}%`;
      this.rangeElement.style.width = "";
    }
  }

  private _updateAriaAttributes() {
    this.setAttribute("aria-valuemin", this.min.toString());
    this.setAttribute("aria-valuemax", this.max.toString());
    this.setAttribute("aria-valuenow", this.value.toString());
    this.setAttribute("aria-disabled", this.disabled.toString());
    this.setAttribute("aria-orientation", this.orientation);
  }

  private _handleTrackMouseDown = (event: MouseEvent): void => {
    if (this.disabled) return;
    event.preventDefault();
    this._updateValueFromPosition(event.clientX, event.clientY);
    this._startDragging();
  };

  private _handleTrackTouchStart = (event: TouchEvent): void => {
    if (this.disabled) return;
    event.preventDefault();
    const touch = event.touches[0];
    this._updateValueFromPosition(touch.clientX, touch.clientY);
    this._startDragging();
  };

  private _handleThumbMouseDown = (event: MouseEvent): void => {
    if (this.disabled) return;
    event.preventDefault();
    event.stopPropagation();
    this._startDragging();
  };

  private _handleThumbTouchStart = (event: TouchEvent): void => {
    if (this.disabled) return;
    event.preventDefault();
    event.stopPropagation();
    this._startDragging();
  };

  private _startDragging(): void {
    this._isDragging = true;
    document.addEventListener("mousemove", this._handleMouseMove);
    document.addEventListener("mouseup", this._handleMouseUp);
    document.addEventListener("touchmove", this._handleTouchMove, {
      passive: false,
    });
    document.addEventListener("touchend", this._handleTouchEnd);
    this.classList.add("dragging");
  }

  private _stopDragging(): void {
    this._isDragging = false;
    document.removeEventListener("mousemove", this._handleMouseMove);
    document.removeEventListener("mouseup", this._handleMouseUp);
    document.removeEventListener("touchmove", this._handleTouchMove);
    document.removeEventListener("touchend", this._handleTouchEnd);
    this.classList.remove("dragging");
  }

  private _handleMouseMove = (event: MouseEvent): void => {
    if (!this._isDragging || this.disabled) return;
    event.preventDefault();
    this._updateValueFromPosition(event.clientX, event.clientY);
  };

  private _handleTouchMove = (event: TouchEvent): void => {
    if (!this._isDragging || this.disabled) return;
    event.preventDefault();
    const touch = event.touches[0];
    this._updateValueFromPosition(touch.clientX, touch.clientY);
  };

  private _handleMouseUp = (): void => {
    this._stopDragging();
  };

  private _handleTouchEnd = (): void => {
    this._stopDragging();
  };

  private _updateValueFromPosition(clientX: number, clientY: number): void {
    if (!this.trackElement) return;

    const rect = this.trackElement.getBoundingClientRect();
    let percentage: number;

    if (this.orientation === "horizontal") {
      const x = clientX - rect.left;
      percentage = (x / rect.width) * 100;
    } else {
      // For vertical sliders, invert the percentage (0% at bottom)
      const y = clientY - rect.top;
      percentage = (1 - y / rect.height) * 100;
    }

    percentage = Math.max(0, Math.min(100, percentage));
    const range = this.max - this.min;
    const newValue = this.min + (percentage / 100) * range;
    const snappedValue = this._snapToStep(newValue);

    if (this.value !== snappedValue) {
      const oldValue = this.value;
      this.value = snappedValue;
      this.emit("ct-input", { value: snappedValue, oldValue });
      this.emit("ct-change", { value: snappedValue, oldValue });
    }
  }

  private _handleKeyDown = (event: KeyboardEvent): void => {
    if (this.disabled) return;

    let newValue = this.value;
    const bigStep = this.step * 10;

    switch (event.key) {
      case "ArrowLeft":
      case "ArrowDown":
        event.preventDefault();
        newValue -= this.step;
        break;
      case "ArrowRight":
      case "ArrowUp":
        event.preventDefault();
        newValue += this.step;
        break;
      case "PageDown":
        event.preventDefault();
        newValue -= bigStep;
        break;
      case "PageUp":
        event.preventDefault();
        newValue += bigStep;
        break;
      case "Home":
        event.preventDefault();
        newValue = this.min;
        break;
      case "End":
        event.preventDefault();
        newValue = this.max;
        break;
      default:
        return;
    }

    const clampedValue = this._clampValue(newValue);
    if (clampedValue !== this.value) {
      const oldValue = this.value;
      this.value = clampedValue;
      this.emit("ct-change", { value: clampedValue, oldValue });
    }
  };

  /**
   * Set the slider value programmatically
   */
  setValue(value: number): void {
    this.value = this._snapToStep(this._clampValue(value));
  }

  /**
   * Get the current value as a percentage (0-100)
   */
  getPercentageValue(): number {
    return this._getPercentage();
  }

  /**
   * Increment the slider value by one step
   */
  increment(): void {
    this.setValue(this.value + this.step);
  }

  /**
   * Decrement the slider value by one step
   */
  decrement(): void {
    this.setValue(this.value - this.step);
  }
}

globalThis.customElements.define("ct-slider", CTSlider);
