import { LitElement } from "lit";
import { state } from "lit/decorators.js";

export const breakpointForWidth = (width: number): String => {
  if (width >= 800) {
    return "lg";
  } else if (width >= 600) {
    return "md";
  } else {
    return "sm";
  }
};

/**
 * This element reacts to changes in its width using a resize observer,
 * allowing for container-based responsive design.
 *
 * Container queries currently do not work correctly with slotted content.
 * (they measure the light DOM container rather than the shadow DOM container
 * they're actually slotted into).
 * See https://chromestatus.com/feature/5242724333387776
 *
 * We use ResizeObserver to measure the element width when it changes and
 * produce a reactive update with `@state`.
 *
 * `render` can access the breakpoint via `.breakpoint()`
 */
export class ResponsiveElement extends LitElement {
  #resizeObserver: ResizeObserver;
  @state() private _observedWidth: number = -1;

  constructor() {
    super();
    this.#resizeObserver = new ResizeObserver((entries) => {
      this._observedWidth = entries.at(0)?.contentRect.width ?? -1;
    });
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.#resizeObserver.disconnect();
    this.#resizeObserver.observe(this);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#resizeObserver.disconnect();
  }

  breakpoint() {
    return breakpointForWidth(this._observedWidth);
  }
}
