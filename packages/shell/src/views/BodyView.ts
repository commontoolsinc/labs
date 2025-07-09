import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { consume } from "@lit/context";
import { AppState } from "../lib/app/mod.ts";
import { appContext } from "../contexts/app.ts";
import { BaseView } from "./BaseView.ts";

export class XBodyView extends BaseView {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      background-color: #eee;
    }
  `;

  @consume({ context: appContext, subscribe: true })
  @property({ attribute: false })
  private app?: AppState;

  override render() {
    return html`
      <div>
        <span>App!!</span>
      </div>
    `;
  }
}

globalThis.customElements.define("x-body-view", XBodyView);
