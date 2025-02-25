import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { baseStyles } from "./style.js";

@customElement("common-google-oauth")
export class CommonGoogleOauthElement extends LitElement {
  @property({ type: Object }) auth;

  override render() {
    return html`
      <div class="input-wrapper">
        <pre>doc: ${JSON.stringify(this.auth, null, 2)}</pre>
      </div>
    `;
  }
}
