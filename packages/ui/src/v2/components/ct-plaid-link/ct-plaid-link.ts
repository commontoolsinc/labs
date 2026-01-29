import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";
import { CellHandle } from "@commontools/runtime-client";
import { CTCharm } from "../ct-charm/ct-charm.ts";

declare global {
  var Plaid: any;
}

export interface PlaidAuthData {
  items: Array<{
    accessToken: string;
    itemId: string;
    institutionId: string;
    institutionName: string;
    accounts: Array<{
      accountId: string;
      name: string;
      mask: string;
      type: string;
      subtype: string;
      balances: {
        available: number | null;
        current: number | null;
        limit: number | null;
        isoCurrencyCode: string | null;
        unofficialCurrencyCode: string | null;
      };
    }>;
    products: string[];
    consentExpirationTime: string | null;
    lastUpdated: string;
    lastSyncCursor: string | null;
  }>;
}

/**
 * CTPlaidLink - Plaid banking integration component
 *
 * @element ct-plaid-link
 *
 * @attr {CellHandle<PlaidAuthData>} auth - Cell containing Plaid authentication data
 * @attr {string[]} products - Array of Plaid products to use (default: ['transactions'])
 *
 * @example
 * <ct-plaid-link .auth=${authCell} .products=${['transactions', 'auth']}></ct-plaid-link>
 */
export class CTPlaidLink extends BaseElement {
  static override properties = {
    auth: { type: Object },
    products: { type: Array },
    isLoading: { type: Boolean },
    authStatus: { type: String },
    plaidScriptLoaded: { type: Boolean },
  };

  declare auth: CellHandle<PlaidAuthData> | undefined;
  declare products: string[];
  declare isLoading: boolean;
  declare authStatus: string;
  declare plaidScriptLoaded: boolean;

  private plaidHandler: any = null;

  constructor() {
    super();
    this.products = ["transactions"];
    this.isLoading = false;
    this.authStatus = "";
    this.plaidScriptLoaded = false;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.loadPlaidScript();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this.plaidHandler) {
      this.plaidHandler.destroy();
      this.plaidHandler = null;
    }
  }

  private loadPlaidScript() {
    if (globalThis.Plaid) {
      this.plaidScriptLoaded = true;
      return;
    }

    const existingScript = document.querySelector(
      'script[src*="plaid.com/link/v2/stable/link-initialize.js"]',
    );
    if (existingScript) {
      existingScript.addEventListener("load", () => {
        this.plaidScriptLoaded = true;
      });
      return;
    }

    const script = document.createElement("script");
    script.src = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
    script.async = true;
    script.onload = () => {
      this.plaidScriptLoaded = true;
    };
    script.onerror = () => {
      console.error("Failed to load Plaid Link script");
      this.authStatus =
        "Failed to load Plaid Link. Please refresh and try again.";
    };
    document.head.appendChild(script);
  }

  async handleConnectClick() {
    if (!this.plaidScriptLoaded || !globalThis.Plaid) {
      this.authStatus = "Plaid Link is still loading, please wait...";
      return;
    }

    this.isLoading = true;
    this.authStatus = "Creating link session...";

    const authCellId = JSON.stringify(this.auth?.ref());

    const container = CTCharm.findCharmContainer(this);
    if (!container) {
      throw new Error("No <ct-charm> container.");
    }
    const { pieceId } = container;

    const payload = {
      authCellId,
      integrationCharmId: pieceId,
      products: this.products,
    };

    try {
      const response = await fetch(
        "/api/integrations/plaid-oauth/create-link-token",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        },
      );

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();

      if (!data.linkToken) {
        throw new Error("No link token received from server");
      }

      this.initializePlaidLink(
        data.linkToken,
        authCellId,
        pieceId || undefined,
      );
    } catch (error) {
      console.error("Error creating link session:", error);
      this.authStatus = `Error: ${
        error instanceof Error ? error.message : String(error)
      }`;
      this.isLoading = false;
    }
  }

  private initializePlaidLink(
    linkToken: string,
    authCellId: string,
    integrationCharmId?: string,
  ) {
    if (this.plaidHandler) {
      this.plaidHandler.destroy();
    }

    const config = {
      token: linkToken,
      onSuccess: async (publicToken: string, _metadata: any) => {
        this.authStatus = "Processing authentication...";
        await this.handlePublicToken(
          publicToken,
          authCellId,
          integrationCharmId,
        );
      },
      onExit: (error: any, _metadata: any) => {
        if (error) {
          this.authStatus = `Authentication failed: ${
            error.error_message || error.display_message || "Unknown error"
          }`;
        } else {
          this.authStatus = "Authentication cancelled";
        }
        this.isLoading = false;
      },
      onEvent: (eventName: string, metadata: any) => {
        if (eventName === "OPEN") {
          this.authStatus = "Link opened...";
        } else if (eventName === "SELECT_INSTITUTION") {
          this.authStatus = `Connecting to ${
            metadata.institution_name || "bank"
          }...`;
        } else if (eventName === "SUBMIT_CREDENTIALS") {
          this.authStatus = "Verifying credentials...";
        }
      },
    };

    this.plaidHandler = globalThis.Plaid.create(config);
    this.plaidHandler.open();
  }

  private async handlePublicToken(
    publicToken: string,
    authCellId: string,
    integrationCharmId?: string,
  ) {
    this.isLoading = true;
    this.authStatus = "Exchanging token...";

    try {
      const response = await fetch(
        "/api/integrations/plaid-oauth/exchange-token",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            publicToken,
            authCellId,
            integrationCharmId,
          }),
        },
      );

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const _result = await response.json();
      this.authStatus = "Bank account connected successfully!";
      this.isLoading = false;

      this.requestUpdate();
    } catch (error) {
      console.error("Error exchanging token:", error);
      this.authStatus = `Error: ${
        error instanceof Error ? error.message : String(error)
      }`;
      this.isLoading = false;
    }
  }

  async handleRemoveAccount(itemId: string) {
    this.isLoading = true;
    this.authStatus = "Removing bank connection...";

    const authCellId = JSON.stringify(this.auth?.ref());

    try {
      const response = await fetch(
        "/api/integrations/plaid-oauth/remove-item",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            authCellId,
            itemId,
          }),
        },
      );

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      this.authStatus = "Bank connection removed successfully";
      this.isLoading = false;

      this.requestUpdate();
    } catch (error) {
      console.error("Error removing account:", error);
      this.authStatus = `Error: ${
        error instanceof Error ? error.message : String(error)
      }`;
      this.isLoading = false;
    }
  }

  formatCurrency(amount: number | null, currencyCode: string | null): string {
    if (amount === null) return "N/A";
    const formatter = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currencyCode || "USD",
    });
    return formatter.format(amount);
  }

  override render() {
    const authData = this.auth?.get();
    const items = authData?.items || [];

    return html`
      <div class="plaid-wrapper">
        ${items.length > 0
          ? html`
            <div class="connected-accounts">
              <h3>Connected Bank Accounts</h3>
              ${items.map((item) =>
                html`
                  <div class="bank-item">
                    <div class="bank-header">
                      <h4>${item.institutionName}</h4>
                      <button
                        @click="${() => this.handleRemoveAccount(item.itemId)}"
                        class="remove-button"
                        ?disabled="${this.isLoading}"
                      >
                        Remove
                      </button>
                    </div>
                    <div class="accounts-list">
                      ${item.accounts.map((account) =>
                        html`
                          <div class="account">
                            <div class="account-info">
                              <span class="account-name">${account.name}</span>
                              <span class="account-mask">****${account
                                .mask}</span>
                              <span class="account-type">${account.subtype ||
                                account.type}</span>
                            </div>
                            <div class="account-balance">
                              <span class="balance-label">Available:</span>
                              <span class="balance-amount">
                                ${this.formatCurrency(
                                  account.balances.available,
                                  account.balances.isoCurrencyCode,
                                )}
                              </span>
                              <span class="balance-label">Current:</span>
                              <span class="balance-amount">
                                ${this.formatCurrency(
                                  account.balances.current,
                                  account.balances.isoCurrencyCode,
                                )}
                              </span>
                            </div>
                          </div>
                        `
                      )}
                    </div>
                    <div class="bank-footer">
                      <span class="last-updated">
                        Last updated: ${new Date(item.lastUpdated)
                          .toLocaleString()}
                      </span>
                    </div>
                  </div>
                `
              )}
            </div>
          `
          : ""}

        <div class="action-section">
          <button
            @click="${this.handleConnectClick}"
            ?disabled="${this.isLoading || !this.plaidScriptLoaded}"
            class="connect-button"
          >
            ${this.isLoading
              ? "Processing..."
              : !this.plaidScriptLoaded
              ? "Loading Plaid..."
              : "Connect Bank Account"}
          </button>

          ${this.authStatus
            ? html`
              <div class="status-message">${this.authStatus}</div>
            `
            : ""}
        </div>
      </div>
    `;
  }

  static override styles = [
    BaseElement.baseStyles,
    css`
      .plaid-wrapper {
        padding: var(--ct-theme-spacing-loose, 1.5rem);
        border-radius: var(
          --ct-theme-border-radius,
          var(--ct-border-radius-lg, 0.5rem)
        );
        background-color: var(
          --ct-theme-color-surface,
          var(--ct-color-white, #ffffff)
        );
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
        max-width: 800px;
      }

      .connected-accounts {
        margin-bottom: var(--ct-theme-spacing-loose, 1.5rem);
      }

      .connected-accounts h3 {
        margin: 0 0 var(--ct-theme-spacing-normal, 1rem);
        color: var(--ct-theme-color-text, var(--ct-color-gray-900, #111827));
        font-size: 1.25rem;
        font-weight: 600;
      }

      .bank-item {
        border: 1px solid
          var(--ct-theme-color-border, var(--ct-color-gray-300, #d1d5db));
        border-radius: var(
          --ct-theme-border-radius,
          var(--ct-border-radius-md, 0.375rem)
        );
        padding: var(--ct-theme-spacing-normal, 1rem);
        margin-bottom: var(--ct-theme-spacing-normal, 1rem);
        background-color: var(
          --ct-theme-color-surface-hover,
          var(--ct-color-gray-50, #f9fafb)
        );
      }

      .bank-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: var(--ct-theme-spacing-normal, 0.75rem);
      }

      .bank-header h4 {
        margin: 0;
        color: var(--ct-theme-color-text, var(--ct-color-gray-900, #111827));
        font-size: 1.1rem;
        font-weight: 600;
      }

      .remove-button {
        background-color: var(
          --ct-theme-color-error,
          var(--ct-color-red-600, #dc2626)
        );
        color: var(
          --ct-theme-color-primary-foreground,
          var(--ct-color-white, #ffffff)
        );
        border: none;
        padding: var(--ct-theme-spacing-tight, 0.375rem)
          var(--ct-theme-spacing-normal, 0.75rem);
        border-radius: var(
          --ct-theme-border-radius,
          var(--ct-border-radius-sm, 0.25rem)
        );
        cursor: pointer;
        font-size: 0.9rem;
        font-family: var(--ct-theme-font-family, inherit);
        transition: background-color var(--ct-theme-animation-duration, 0.2s) ease;
      }

      .remove-button:hover {
        background-color: var(
          --ct-theme-color-error,
          var(--ct-color-red-700, #b91c1c)
        );
      }

      .remove-button:disabled {
        background-color: var(
          --ct-theme-color-border,
          var(--ct-color-gray-300, #d1d5db)
        );
        cursor: not-allowed;
      }

      .accounts-list {
        display: flex;
        flex-direction: column;
        gap: var(--ct-theme-spacing-normal, 0.75rem);
      }

      .account {
        background-color: var(
          --ct-theme-color-surface,
          var(--ct-color-white, #ffffff)
        );
        border: 1px solid
          var(--ct-theme-color-border, var(--ct-color-gray-200, #e5e7eb));
        border-radius: var(
          --ct-theme-border-radius,
          var(--ct-border-radius-md, 0.375rem)
        );
        padding: var(--ct-theme-spacing-normal, 0.75rem);
      }

      .account-info {
        display: flex;
        gap: var(--ct-theme-spacing-normal, 0.75rem);
        margin-bottom: var(--ct-theme-spacing-tight, 0.5rem);
        align-items: center;
      }

      .account-name {
        font-weight: 500;
        color: var(--ct-theme-color-text, var(--ct-color-gray-900, #111827));
      }

      .account-mask {
        color: var(
          --ct-theme-color-text-muted,
          var(--ct-color-gray-600, #6b7280)
        );
        font-size: 0.9rem;
      }

      .account-type {
        background-color: #e8f0fe;
        color: #1a73e8;
        padding: 0.125rem var(--ct-theme-spacing-tight, 0.5rem);
        border-radius: var(
          --ct-theme-border-radius-full,
          var(--ct-radius-full, 9999px)
        );
        font-size: 0.8rem;
        text-transform: capitalize;
      }

      .account-balance {
        display: flex;
        gap: var(--ct-theme-spacing-normal, 1rem);
        align-items: center;
        font-size: 0.95rem;
      }

      .balance-label {
        color: var(
          --ct-theme-color-text-muted,
          var(--ct-color-gray-600, #6b7280)
        );
      }

      .balance-amount {
        font-weight: 500;
        color: var(--ct-theme-color-text, var(--ct-color-gray-900, #111827));
      }

      .bank-footer {
        margin-top: var(--ct-theme-spacing-normal, 0.75rem);
        padding-top: var(--ct-theme-spacing-normal, 0.75rem);
        border-top: 1px solid
          var(--ct-theme-color-border, var(--ct-color-gray-200, #e5e7eb));
        }

        .last-updated {
          color: var(
            --ct-theme-color-text-muted,
            var(--ct-color-gray-600, #6b7280)
          );
          font-size: 0.85rem;
        }

        .action-section {
          display: flex;
          flex-direction: column;
          gap: var(--ct-theme-spacing-normal, 1rem);
        }

        .connect-button {
          background-color: #1db954;
          color: white;
          border: none;
          padding: var(--ct-theme-spacing-normal, 0.75rem)
            var(--ct-theme-spacing-loose, 1.5rem);
          border-radius: var(
            --ct-theme-border-radius,
            var(--ct-border-radius-md, 0.375rem)
          );
          cursor: pointer;
          font-weight: 500;
          font-size: 1rem;
          font-family: var(--ct-theme-font-family, inherit);
          transition: background-color var(--ct-theme-animation-duration, 0.2s) ease;
        }

        .connect-button:hover {
          background-color: #1aa34a;
        }

        .connect-button:disabled {
          background-color: var(
            --ct-theme-color-border,
            var(--ct-color-gray-300, #d1d5db)
          );
          cursor: not-allowed;
        }

        .status-message {
          padding: var(--ct-theme-spacing-normal, 0.75rem);
          border-radius: var(
            --ct-theme-border-radius,
            var(--ct-border-radius-md, 0.375rem)
          );
          background-color: #e8f5e9;
          color: #2e7d32;
          font-size: 0.9rem;
          text-align: center;
        }
      `,
    ];
  }

  globalThis.customElements.define("ct-plaid-link", CTPlaidLink);
