import { css, html, LitElement } from "lit";
import { baseStyles } from "./style.ts";
import { Cell } from "@commontools/runner";
import { CommonCharmElement } from "./common-charm.ts";

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

export class CommonPlaidOauthElement extends LitElement {
  static override properties = {
    auth: { type: Object },
    products: { type: Array },
    isLoading: { type: Boolean },
    authStatus: { type: String },
  };

  declare auth: Cell<PlaidAuthData> | undefined;
  declare products: string[];
  declare isLoading: boolean;
  declare authStatus: string;

  constructor() {
    super();
    this.products = ["transactions"];  // transactions includes balance/account info
    this.isLoading = false;
    this.authStatus = "";
  }


  override connectedCallback() {
    super.connectedCallback();
    // Check for OAuth callback on component mount
    this.checkForOAuthCallback();
  }

  private async checkForOAuthCallback() {
    // Check if we're returning from Plaid OAuth
    const urlParams = new URLSearchParams(window.location.search);
    const publicToken = urlParams.get("public_token");
    const error = urlParams.get("error");
    const oauthContinue = urlParams.get("oauth_continue");
    const oauthStateId = urlParams.get("oauth_state_id");
    
    
    if (publicToken || error || oauthContinue) {
      if (error) {
        this.authStatus = `Authentication failed: ${urlParams.get("error_message") || error}`;
        // Clean up URL
        window.history.replaceState({}, document.title, window.location.pathname);
      } else if (publicToken) {
        // Handle the public token exchange
        this.authStatus = "Processing authentication...";
        await this.handlePublicToken(publicToken);
        
        // Clean up URL and sessionStorage
        window.history.replaceState({}, document.title, window.location.pathname);
        sessionStorage.removeItem('plaid_link_token');
        sessionStorage.removeItem('plaid_auth_cell_id');
        sessionStorage.removeItem('plaid_integration_charm_id');
        sessionStorage.removeItem('plaid_frontend_url');
        sessionStorage.removeItem('plaid_oauth_state_id');
        sessionStorage.removeItem('plaid_oauth_completed');
      } else if (oauthContinue && oauthStateId) {
        // This shouldn't happen anymore with proper hosted Link setup
        // But keeping for backward compatibility
        this.authStatus = "Unexpected OAuth callback. Please try again.";
        // Clean up URL
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    }
  }

  private async handlePublicToken(publicToken: string) {
    this.isLoading = true;
    this.authStatus = "Exchanging token...";

    const authCellId = JSON.stringify(this.auth?.getAsCellLink());
    const container = CommonCharmElement.findCharmContainer(this);
    if (!container) {
      throw new Error("No <common-charm> container.");
    }
    const { charmId } = container;

    try {
      const response = await fetch("/api/integrations/plaid-oauth/exchange-token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          publicToken,
          authCellId,
          integrationCharmId: charmId,
        }),
      });

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

  async handleConnectClick() {
    this.isLoading = true;
    this.authStatus = "Creating link session...";

    const authCellId = JSON.stringify(this.auth?.getAsCellLink());

    const container = CommonCharmElement.findCharmContainer(this);
    if (!container) {
      throw new Error("No <common-charm> container.");
    }
    const { charmId } = container;

    const payload = {
      authCellId,
      integrationCharmId: charmId,
      products: this.products,
      // Send the current page URL so the callback knows where to redirect
      frontendUrl: window.location.href.split('?')[0],
    };

    try {
      const response = await fetch("/api/integrations/plaid-oauth/create-link-token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      
      if (data.hostedLinkUrl && data.linkToken) {
        // Store session data in sessionStorage for frontend use
        sessionStorage.setItem('plaid_link_token', data.linkToken);
        sessionStorage.setItem('plaid_auth_cell_id', authCellId);
        sessionStorage.setItem('plaid_frontend_url', window.location.href.split('?')[0]);
        if (charmId) {
          sessionStorage.setItem('plaid_integration_charm_id', charmId);
        }
        
        // Redirect to Plaid hosted Link
        this.authStatus = "Redirecting to Plaid...";
        window.location.href = data.hostedLinkUrl;
      } else {
        throw new Error("No hosted link URL or link token received");
      }
    } catch (error) {
      console.error("Error creating link session:", error);
      this.authStatus = `Error: ${
        error instanceof Error ? error.message : String(error)
      }`;
      this.isLoading = false;
    }
  }

  private async pollForOAuthCompletion(linkToken: string, authCellId: string, integrationCharmId?: string, attempt = 0) {
    const maxAttempts = 60; // Poll for up to 2 minutes
    
    // Set loading state on first attempt
    if (attempt === 0) {
      this.isLoading = true;
    }
    
    try {
      const response = await fetch("/api/integrations/plaid-oauth/complete-oauth", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          linkToken,
          authCellId,
          integrationCharmId,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        
        // If session is still in progress, keep polling
        if (errorData.error === "Link session still in progress" && attempt < maxAttempts) {
          const elapsed = attempt * 2;
          this.authStatus = `Waiting for bank authorization... (${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')})`;
          
          await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
          return this.pollForOAuthCompletion(linkToken, authCellId, integrationCharmId, attempt + 1);
        }
        
        // If we've hit max attempts, show error
        if (attempt >= maxAttempts) {
          this.authStatus = "Bank authorization is taking too long. Please try again.";
          this.isLoading = false;
          
          // Clean up session storage
          sessionStorage.removeItem('plaid_link_token');
          sessionStorage.removeItem('plaid_auth_cell_id');
          sessionStorage.removeItem('plaid_integration_charm_id');
          sessionStorage.removeItem('plaid_oauth_state_id');
          return;
        }
        
        throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
      }

      const result = await response.json();
      
      if (result.publicToken) {
        // Exchange the public token
        await this.handlePublicToken(result.publicToken);
      } else {
        this.authStatus = "Unexpected response from server. Please try again.";
        this.isLoading = false;
      }
      
      // Clean up session storage
      sessionStorage.removeItem('plaid_link_token');
      sessionStorage.removeItem('plaid_auth_cell_id');
      sessionStorage.removeItem('plaid_integration_charm_id');
      sessionStorage.removeItem('plaid_oauth_state_id');
    } catch (error) {
      console.error("Error polling for OAuth completion:", error);
      this.authStatus = `Error: ${
        error instanceof Error ? error.message : String(error)
      }`;
      this.isLoading = false;
    }
  }

  private async completeOAuthFlow(linkToken: string, authCellId: string, integrationCharmId?: string) {
    this.isLoading = true;
    
    try {
      const response = await fetch("/api/integrations/plaid-oauth/complete-oauth", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          linkToken,
          authCellId,
          integrationCharmId,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
      }

      const result = await response.json();
      
      if (result.publicToken) {
        // Exchange the public token
        await this.handlePublicToken(result.publicToken);
      } else {
        this.authStatus = "Bank account connected successfully!";
        this.isLoading = false;
        this.requestUpdate();
      }
    } catch (error) {
      console.error("Error completing OAuth flow:", error);
      this.authStatus = `Error: ${
        error instanceof Error ? error.message : String(error)
      }`;
      this.isLoading = false;
    }
  }

  async handleRemoveAccount(itemId: string) {
    this.isLoading = true;
    this.authStatus = "Removing bank connection...";

    const authCellId = JSON.stringify(this.auth?.getAsCellLink());

    try {
      const response = await fetch("/api/integrations/plaid-oauth/remove-item", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          authCellId,
          itemId,
        }),
      });

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
              ${items.map((item) => html`
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
                    ${item.accounts.map((account) => html`
                      <div class="account">
                        <div class="account-info">
                          <span class="account-name">${account.name}</span>
                          <span class="account-mask">****${account.mask}</span>
                          <span class="account-type">${account.subtype || account.type}</span>
                        </div>
                        <div class="account-balance">
                          <span class="balance-label">Available:</span>
                          <span class="balance-amount">
                            ${this.formatCurrency(
                              account.balances.available,
                              account.balances.isoCurrencyCode
                            )}
                          </span>
                          <span class="balance-label">Current:</span>
                          <span class="balance-amount">
                            ${this.formatCurrency(
                              account.balances.current,
                              account.balances.isoCurrencyCode
                            )}
                          </span>
                        </div>
                      </div>
                    `)}
                  </div>
                  <div class="bank-footer">
                    <span class="last-updated">
                      Last updated: ${new Date(item.lastUpdated).toLocaleString()}
                    </span>
                  </div>
                </div>
              `)}
            </div>
          `
          : ""
        }

        <div class="action-section">
          <button 
            @click="${this.handleConnectClick}"
            ?disabled="${this.isLoading}"
            class="connect-button"
          >
            ${this.isLoading ? "Processing..." : "Connect Bank Account"}
          </button>
          
          ${this.authStatus
            ? html`
              <div class="status-message">${this.authStatus}</div>
            `
            : ""
          }
        </div>

        <details class="debug-section">
          <summary>Debug: Auth Cell Contents</summary>
          <pre class="debug-content">${JSON.stringify(authData, null, 2)}</pre>
        </details>
      </div>
    `;
  }

  static override get styles() {
    return [
      baseStyles,
      css`
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

        .debug-section {
          margin-top: 24px;
          padding: 16px;
          background-color: #f5f5f5;
          border-radius: 8px;
          border: 1px solid #ddd;
        }

        .debug-section summary {
          cursor: pointer;
          font-weight: 500;
          color: #666;
          user-select: none;
        }

        .debug-content {
          margin-top: 12px;
          padding: 12px;
          background-color: #fff;
          border: 1px solid #e0e0e0;
          border-radius: 4px;
          overflow-x: auto;
          font-family: monospace;
          font-size: 0.85rem;
          white-space: pre;
          color: #333;
        }
      `,
    ];
  }
}

globalThis.customElements.define(
  "common-plaid-oauth",
  CommonPlaidOauthElement,
);