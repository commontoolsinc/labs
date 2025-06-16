import { css, html, LitElement } from "lit";
import { baseStyles } from "./style.ts";
import { CommonCharmElement } from "./common-charm.ts";
import { Cell } from "@commontools/runner";

export class CommonUpdaterElement extends LitElement {
  static override styles = [
    baseStyles,
    css`
      :host {
        --button-background: #000;
        --button-color: #fff;
        --button-height: 40px;
        --button-success-background: #2e7d32;
        --button-error-background: #d32f2f;
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

      .button[data-state="pending"] {
        cursor: wait;
        opacity: 0.7;
      }

      .button[data-state="success"] {
        background-color: var(--button-success-background);
      }

      .button[data-state="error"] {
        background-color: var(--button-error-background);
      }
    `,
  ];
  declare state: Cell<any>;
  declare integration: string;
  private updateState: "idle" | "pending" | "success" | "error" = "idle";

  private async handleClick() {
    if (this.updateState === "pending") return;

    this.updateState = "pending";
    this.requestUpdate();

    const container = CommonCharmElement.findCharmContainer(this);
    if (!container) {
      throw new Error("No <common-charm> container.");
    }
    const { charmId } = container;
    const space = this.state.getAsLink()["@"]["link-v0.1"].space;
    const payload = {
      charmId,
      space,
      integration: this.integration!,
    };

    try {
      const response = await fetch(`/api/integrations/bg`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const result = await response.json();

      if (result.success) {
        this.updateState = "success";
      } else {
        console.log("updater error", result);
        this.updateState = "error";
      }
    } catch (error) {
      console.log("updater error", error);
      this.updateState = "error";
    }

    this.requestUpdate();

    // Reset state after 3 seconds
    setTimeout(() => {
      this.updateState = "idle";
      this.requestUpdate();
    }, 3000);
  }

  override render() {
    const buttonText = {
      idle: "Register Charm for Updates",
      pending: "Registering...",
      success: "Successfully Registered!",
      error: "Registration Failed",
    }[this.updateState];

    return html`
      <button
        class="button"
        @click="${this.handleClick}"
        data-state="${this.updateState}"
      >
        ${buttonText}
      </button>
    `;
  }
}

globalThis.customElements.define("common-updater", CommonUpdaterElement);
