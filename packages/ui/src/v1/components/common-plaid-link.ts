import { css, html, LitElement } from "lit";
import { baseStyles } from "./style.ts";
import { Cell } from "@commontools/runner";
import { CommonCharmElement } from "./common-charm.ts";

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

export class CommonPlaidLinkElement extends LitElement {
  static override properties = {
    auth: { type: Object },
    products: { type: Array },
    isLoading: { type: Boolean },
    authStatus: { type: String },
    plaidScriptLoaded: { type: Boolean },
  };

  declare auth: Cell<PlaidAuthData> | undefined;
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
    // Cleanup Plaid handler
    if (this.plaidHandler) {
      this.plaidHandler.destroy();
      this.plaidHandler = null;
    }
  }

  private loadPlaidScript() {
    // Check if already loaded
    if (globalThis.Plaid) {
      this.plaidScriptLoaded = true;
      return;
    }

    // Check if script tag already exists
    const existingScript = document.querySelector(
      'script[src*="plaid.com/link/v2/stable/link-initialize.js"]',
    );
    if (existingScript) {
      existingScript.addEventListener("load", () => {
        this.plaidScriptLoaded = true;
      });
      return;
    }

    // Load the script
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

    const authCellId = JSON.stringify(this.auth?.getAsLink());

    const container = CommonCharmElement.findCharmContainer(this);
    if (!container) {
      throw new Error("No <common-charm> container.");
    }
    const { charmId } = container;

    const payload = {
      authCellId,
      integrationCharmId: charmId,
      products: this.products,
    };

    try {
      // Get link token from backend
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

      // Initialize Plaid Link
      this.initializePlaidLink(
        data.linkToken,
        authCellId,
        charmId || undefined,
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
    // Destroy existing handler if any
    if (this.plaidHandler) {
      this.plaidHandler.destroy();
    }

    const config = {
      token: linkToken,
      onSuccess: async (publicToken: string, metadata: any) => {
        this.authStatus = "Processing authentication...";
        await this.handlePublicToken(
          publicToken,
          authCellId,
          integrationCharmId,
        );
      },
      onExit: (error: any, metadata: any) => {
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
        // Update status based on events
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

    // Open Link immediately
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

      const result = await response.json();
      this.authStatus = "Bank account connected successfully!";
      this.isLoading = false;

      // Force update to show new account
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

    const authCellId = JSON.stringify(this.auth?.getAsLink());

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

      // Force update to reflect removal
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
                      <span class="account-mask">****${account.mask}</span>
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
                    Last updated: ${new Date(item.lastUpdated).toLocaleString()}
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

  static override get styles() {
    return [
      baseStyles,
      css`
        /* Same styles as common-plaid-oauth */
        .plaid-wrapper {
          padding: 24px;
          border-radius: 12px;
          background-color: #ffffff;
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
          max-width: 800px;
        }

        .connected-accounts {
          margin-bottom: 24px;
        }

        .connected-accounts h3 {
          margin: 0 0 16px;
          color: #333;
          font-size: 1.25rem;
        }

        .bank-item {
          border: 1px solid #e0e0e0;
          border-radius: 8px;
          padding: 16px;
          margin-bottom: 16px;
          background-color: #f9f9f9;
        }

        .bank-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 12px;
        }

        .bank-header h4 {
          margin: 0;
          color: #333;
          font-size: 1.1rem;
        }

        .remove-button {
          background-color: #dc3545;
          color: white;
          border: none;
          padding: 6px 12px;
          border-radius: 4px;
          cursor: pointer;
          font-size: 0.9rem;
          transition: background-color 0.2s ease;
        }

        .remove-button:hover {
          background-color: #c82333;
        }

        .remove-button:disabled {
          background-color: #cccccc;
          cursor: not-allowed;
        }

        .accounts-list {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .account {
          background-color: white;
          border: 1px solid #e8e8e8;
          border-radius: 6px;
          padding: 12px;
        }

        .account-info {
          display: flex;
          gap: 12px;
          margin-bottom: 8px;
          align-items: center;
        }

        .account-name {
          font-weight: 500;
          color: #333;
        }

        .account-mask {
          color: #666;
          font-size: 0.9rem;
        }

        .account-type {
          background-color: #e8f0fe;
          color: #1a73e8;
          padding: 2px 8px;
          border-radius: 12px;
          font-size: 0.8rem;
          text-transform: capitalize;
        }

        .account-balance {
          display: flex;
          gap: 16px;
          align-items: center;
          font-size: 0.95rem;
        }

        .balance-label {
          color: #666;
        }

        .balance-amount {
          font-weight: 500;
          color: #333;
        }

        .bank-footer {
          margin-top: 12px;
          padding-top: 12px;
          border-top: 1px solid #e0e0e0;
        }

        .last-updated {
          color: #666;
          font-size: 0.85rem;
        }

        .action-section {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .connect-button {
          background-color: #1db954;
          color: white;
          border: none;
          padding: 12px 24px;
          border-radius: 6px;
          cursor: pointer;
          font-weight: 500;
          font-size: 1rem;
          transition: background-color 0.2s ease;
        }

        .connect-button:hover {
          background-color: #1aa34a;
        }

        .connect-button:disabled {
          background-color: #cccccc;
          cursor: not-allowed;
        }

        .status-message {
          padding: 12px;
          border-radius: 6px;
          background-color: #e8f5e9;
          color: #2e7d32;
          font-size: 0.9rem;
          text-align: center;
        }
      `,
    ];
  }
}

globalThis.customElements.define(
  "common-plaid-link",
  CommonPlaidLinkElement,
);
