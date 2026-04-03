import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";
import { CTPiece } from "../ct-piece/ct-piece.ts";
import { CellHandle } from "@commontools/runtime-client";

/**
 * CTUpdater - Button component for registering pieces for background updates
 *
 * @element ct-updater
 *
 * @attr {Cell} state - Cell state object
 * @attr {string} integration - Integration name/identifier
 *
 * @example
 * <ct-updater .state=${cellState} integration="my-integration"></ct-updater>
 */
export class CTUpdater extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        --button-background: var(
          --ct-theme-color-primary,
          var(--ct-color-primary, #3b82f6)
        );
        --button-color: var(
          --ct-theme-color-primary-foreground,
          var(--ct-color-white, #ffffff)
        );
        --button-height: 2.5rem;
        --button-success-background: var(
          --ct-theme-color-success,
          var(--ct-color-green-600, #16a34a)
        );
        --button-error-background: var(
          --ct-theme-color-error,
          var(--ct-color-red-600, #dc2626)
        );
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
        font-size: 0.875rem;
        font-family: var(--ct-theme-font-family, inherit);
        font-weight: 500;
        height: var(--button-height);
        justify-content: center;
        overflow: hidden;
        line-height: 1.25rem;
        padding: 0.5rem 1.25rem;
        text-align: center;
        text-wrap: nowrap;
        width: 100%;
        transition: all var(--ct-theme-animation-duration, 0.2s) ease;
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

      .button:hover:not([data-state="pending"]) {
        opacity: 0.9;
        transform: translateY(-1px);
      }

      .button:active:not([data-state="pending"]) {
        transform: translateY(0);
      }
    `,
  ];

  static override properties = {
    state: { type: Object },
    integration: { type: String },
  };

  declare state: CellHandle<any>;
  declare integration: string;
  private updateState: "idle" | "pending" | "success" | "error" = "idle";

  private async handleClick() {
    if (this.updateState === "pending") return;

    this.updateState = "pending";
    this.requestUpdate();

    const container = CTPiece.findPieceContainer(this);
    if (!container) {
      throw new Error("No <ct-piece> container.");
    }
    const { pieceId } = container;
    const space = this.state.space;
    const payload = {
      pieceId,
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
      idle: "Register Piece for Updates",
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

globalThis.customElements.define("ct-updater", CTUpdater);
