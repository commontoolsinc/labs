import { html } from "lit";
import { BaseElement } from "../../core/base-element.ts";
import { property } from "lit/decorators.js";
import { type CellHandle, isCellHandle } from "@commontools/runtime-client";

export class CTRouter extends BaseElement {
  @property({ attribute: false })
  path: CellHandle<string> | string = "/";

  override connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener("ct-route-change", this.onRouteChange);
  }

  onRouteChange = (e: Event) => {
    e.stopPropagation();
    const { to } = (e as CustomEvent<{ to: string }>).detail;
    if (isCellHandle(this.path)) {
      this.path.set(to);
    } else {
      this.path = to;
    }
  };

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener("ct-route-change", this.onRouteChange);
  }

  override render() {
    return html`
      <slot></slot>
    `;
  }
}

globalThis.customElements.define("ct-router", CTRouter);
