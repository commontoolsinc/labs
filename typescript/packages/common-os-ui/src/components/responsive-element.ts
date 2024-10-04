import { LitElement } from "lit";

export const breakpointLg = 800;
export const breakpointMd = 600;

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
  #observedWidth: number = -1;

  constructor() {
    super();
    const isSelf = (entry: ResizeObserverEntry) => entry.target === this;
    this.#resizeObserver = new ResizeObserver((entries) => {
      const entry = entries.find(isSelf);
      const observedWidth = entry?.contentRect.width ?? -1;
      if (this.#observedWidth !== observedWidth) {
        this.#observedWidth = observedWidth;
        this.requestUpdate();
      }
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

  getObservedWidth() {
    return this.#observedWidth;
  }
}
