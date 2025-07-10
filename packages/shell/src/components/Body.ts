import { css, html, PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import { BaseView } from "../views/BaseView.ts";
import { CharmsController } from "@commontools/charm/ops";
import { Identity } from "@commontools/identity";

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
  cc?: CharmsController;

  @property({ attribute: false })
  activeCharmId?: string;

  @property({ attribute: false })
  identity?: Identity;

  override render() {
    const cc = this.cc ? "Connected" : "Not Connected";
    console.log("BODY RENDER", this.cc);

    const identityDisplay = this.identity
      ? this.identity.did()
      : "Not authenticated";

    return html`
      <div>
        <h2>App!!</h2>
        <div>User Identity: ${identityDisplay}</div>
        <div>Controller: ${cc}</div>
      </div>
    `;
  }
}

globalThis.customElements.define("x-body", XBodyElement);
