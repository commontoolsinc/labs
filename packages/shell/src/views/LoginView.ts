import { css, html } from "lit";
import { ANYONE, Identity } from "@commontools/identity";
import { BaseView } from "./BaseView.ts";

export class XLoginView extends BaseView {
  static override styles = css`
    :host {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      height: 100%;
    }

    button {
      padding: 0.5rem 1rem;
      font-family: var(--font-primary);
      background-color: white;
      border: var(--border-width, 2px) solid var(--border-color, #000);
      cursor: pointer;
      transition: background-color 0.2s;
    }

    button:hover {
      background-color: var(--bg-secondary, #f9fafb);
    }
  `;

  async onLogin(e: Event) {
    e.preventDefault();
    const identity = await Identity.fromPassphrase(ANYONE);
    this.command({ type: "set-identity", identity });
  }

  override render() {
    return html`
      <button @click="${this.onLogin}">Anonymous Login</button>
    `;
  }
}

globalThis.customElements.define("x-login-view", XLoginView);
