import { css, html, LitElement } from "lit";
import { baseStyles } from "./style.ts";
import { Cell } from "@commontools/runner";
export class CommonUpdaterElement extends LitElement {
  static override styles = [
    baseStyles,
    css`
      :host {
        --button-background: #000;
        --button-color: #fff;
        --button-height: 40px;
        display: block;
      }

      .button {
        align-items: center;
        appearance: none;
        background-color: var(--button-background);
        border: 0;
        box-sizing: border-box;
        border-radius: calc(var(--button-height) / 2);
        color: var(--button-color);
        cursor: pointer;
        display: flex;
        font-size: var(--body-size);
        height: var(--button-height);
        justify-content: center;
        overflow: hidden;
        line-height: 20px;
        padding: 8px 20px;
        text-align: center;
        text-wrap: nowrap;
        width: 100%;
      }
    `,
  ];
  declare state: Cell<any>;
  declare integration: string;

  private handleClick() {
    const charmId = globalThis.location.pathname.split("/")[1];
    const cleanCharmId = charmId?.split(/[-?/]/)[0];
    const space = this.state.getAsCellLink().space;
    const payload = {
      charmId,
      space,
      integration: this.integration!,
    };
    console.log("payload", payload);

    fetch(`/api/integrations/bg`, {
      method: "POST",
      body: JSON.stringify(payload),
    }).then((res) => res.json()).then(console.log);
  }

  override render() {
    return html`
      <button class="button" @click=${this.handleClick}>
        Register Charm for Updates
      </button>
    `;
  }
}

globalThis.customElements.define("common-updater", CommonUpdaterElement);
