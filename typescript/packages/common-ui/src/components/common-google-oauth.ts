import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { baseStyles } from "./style.js";

@customElement("common-google-oauth")
export class CommonGoogleOauthElement extends LitElement {
  @property({ type: Object }) auth;

  async handleClick() {
    const authCellId = JSON.stringify(this.auth, null, 2);
    const payload = {
      authCellId,
    };

    const response = await fetch("/api/integrations/google-oauth/login", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    const resp = await response.json();
    console.log(resp.url);

    window.open(resp.url, "_blank", "width=800,height=600,left=200,top=200");
  }

  override render() {
    return html`
      <div class="input-wrapper">
        <h1>hello</h1>
        <pre>doc: ${JSON.stringify(this.auth, null, 2)}</pre>
        <button @click=${this.handleClick}>click me</button>
      </div>
    `;
  }
}
