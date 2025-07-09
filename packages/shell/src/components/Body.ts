import { css, html, PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import { BaseView } from "../views/BaseView.ts";
import { CharmController } from "@commontools/charm/ops";

export class XBodyElement extends BaseView {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      background-color: white;
      padding: 1rem;
    }
  `;

  @property({ attribute: false })
  cc?: CharmController;

  @property({ attribute: false })
  activeCharmId?: string;

  override render() {
    const cc = this.cc ? "Connected" : "Not Connected";
    console.log("BODY RENDER", this.cc);
    return html`
      <div>
        <h2>App!!</h2>
        <div>${cc}</div>
        <div>Active Charm Id: ${this.activeCharmId}</div>
      </div>
    `;
  }
}

globalThis.customElements.define("x-body", XBodyElement);
