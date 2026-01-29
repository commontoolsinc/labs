import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";
import { CellHandle } from "@commontools/runtime-client";
import { CTCharm } from "../ct-charm/ct-charm.ts";

export interface AuthData {
  token?: string;
  tokenType?: string;
  scope?: string[];
  expiresIn?: number;
  refreshToken?: string;
  expiresAt?: number;
  user?: {
    email: string;
    name: string;
    picture: string;
  };
}

/**
 * CTGoogleOauth - Google OAuth authentication component
 *
 * @element ct-google-oauth
 *
 * @attr {CellHandle<AuthData>} auth - Cell containing authentication data
 * @attr {string[]} scopes - Array of OAuth scopes to request
 *
 * @example
 * <ct-google-oauth .auth=${authCell} .scopes=${['email', 'profile']}></ct-google-oauth>
 */
export class CTGoogleOauth extends BaseElement {
  static override properties = {
    auth: { type: Object },
    authStatus: { type: String },
    isLoading: { type: Boolean },
    authResult: { type: Object },
    scopes: { type: Array },
  };

  declare auth: CellHandle<AuthData>;
  declare authStatus: string;
  declare isLoading: boolean;
  declare authResult: Record<string, unknown> | null;
  declare scopes: string[] | undefined;

  constructor() {
    super();
    this.authStatus = "";
    this.isLoading = false;
    this.authResult = null;
  }

  override connectedCallback() {
    super.connectedCallback();
  }

  override updated(changedProperties: Map<string | number | symbol, unknown>) {
    super.updated(changedProperties);
  }

  async handleClick() {
    this.isLoading = true;
    this.authStatus = "Initiating OAuth flow...";
    this.authResult = null;

    const authCellId = JSON.stringify(this.auth.ref());

    const container = CTCharm.findCharmContainer(this);
    if (!container) {
      throw new Error("No <ct-charm> container.");
    }
    const { pieceId } = container;
    const payload = {
      authCellId,
      integrationCharmId: pieceId,
      scopes: this.scopes,
    };

    try {
      const response = await fetch("/api/integrations/google-oauth/login", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const resp = await response.json();
      this.authStatus = "Opening OAuth window...";

      const messageListener = (event: MessageEvent) => {
        if (event.origin !== globalThis.location.origin) return;

        if (event.data && event.data.type === "oauth-callback") {
          this.authResult = event.data.result;
          this.authStatus = event.data.result.success
            ? "Authentication successful!"
            : `Authentication failed: ${
              event.data.result.error || "Unknown error"
            }`;
          this.isLoading = false;
          globalThis.removeEventListener("message", messageListener);
        }
      };

      globalThis.addEventListener("message", messageListener);

      const authWindow = globalThis.open(
        resp.url,
        "_blank",
        "width=800,height=800,left=200,top=200",
      );

      if (authWindow) {
        const checkWindowClosed = setInterval(() => {
          if (authWindow.closed) {
            clearInterval(checkWindowClosed);
            if (!this.authResult) {
              this.authStatus =
                "OAuth window closed. Authentication may not have completed.";
              this.isLoading = false;
            }
            globalThis.removeEventListener("message", messageListener);
          }
        }, 500);
      }
    } catch (error: unknown) {
      console.error("OAuth error:", error);
      this.authStatus = `Error: ${
        error instanceof Error ? error.message : String(error)
      }`;
      this.isLoading = false;
    }
  }

  async handleLogout() {
    await this.auth.set({
      token: "",
      tokenType: "",
      scope: [],
      expiresIn: 0,
      expiresAt: 0,
      refreshToken: "",
      user: {
        email: "",
        name: "",
        picture: "",
      },
    });
    this.requestUpdate();
  }

  override render() {
    return html`
      <div class="oauth-wrapper">
        <div class="profile-section">
          ${this.auth.get()?.user?.email && this.auth.get()?.token
            ? html`
              <img class="profile-picture" src="${this.auth.get()?.user
                ?.picture}" alt="User profile picture" />
              <div class="user-info">
                <h2 class="user-name">${this.auth.get()?.user?.name}</h2>
                <p class="user-email">${this.auth.get()?.user?.email}</p>
              </div>
            `
            : ""}
        </div>

        <div class="action-section">
          ${this.auth.get()?.token
            ? html`
              <button @click="${this.handleLogout}" class="oauth-button logout">
                Logout
              </button>
            `
            : html`
              <button @click="${this.handleClick}" ?disabled="${this
                .isLoading}" class="oauth-button">
                ${this.isLoading ? "Processing..." : "Authenticate with Google"}
              </button>
            `} ${this.authStatus
            ? html`
              <div class="status-message">${this.authStatus}</div>
            `
            : ""}
        </div>

        ${this.authResult
          ? html`
            <div class="auth-result">
              <h3>Authentication Result</h3>
              <pre>${JSON.stringify(this.authResult, null, 2)}</pre>
            </div>
          `
          : ""}
      </div>
    `;
  }

  static override styles = [
    BaseElement.baseStyles,
    css`
      .oauth-wrapper {
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
        max-width: 600px;
      }

      .profile-section {
        display: flex;
        align-items: center;
        gap: var(--ct-theme-spacing-loose, 1.25rem);
        margin-bottom: var(--ct-theme-spacing-loose, 1.5rem);
      }

      .profile-picture {
        width: 80px;
        height: 80px;
        border-radius: 50%;
        object-fit: cover;
      }

      .user-info {
        flex: 1;
      }

      .user-name {
        margin: 0;
        font-size: 1.5rem;
        color: var(--ct-theme-color-text, var(--ct-color-gray-900, #111827));
        font-weight: 600;
      }

      .user-email {
        margin: 0.25rem 0 0;
        color: var(
          --ct-theme-color-text-muted,
          var(--ct-color-gray-600, #6b7280)
        );
      }

      .action-section {
        display: flex;
        flex-direction: column;
        gap: var(--ct-theme-spacing-normal, 1rem);
        margin-bottom: var(--ct-theme-spacing-loose, 1.5rem);
      }

      .oauth-button {
        background-color: #4285f4;
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

      .oauth-button:hover {
        background-color: #3367d6;
      }

      .oauth-button:disabled {
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
        background-color: #e8f0fe;
        color: #1a73e8;
        font-size: 0.9rem;
      }

      .auth-result {
        background-color: var(
          --ct-theme-color-surface-hover,
          var(--ct-color-gray-50, #f9fafb)
        );
        padding: var(--ct-theme-spacing-normal, 1rem);
        border-radius: var(
          --ct-theme-border-radius,
          var(--ct-border-radius-md, 0.375rem)
        );
      }

      .auth-result h3 {
        margin: 0 0 0.75rem;
        color: var(--ct-theme-color-text, var(--ct-color-gray-900, #111827));
      }

      .auth-result pre {
        background-color: var(
          --ct-theme-color-surface,
          var(--ct-color-white, #ffffff)
        );
        padding: var(--ct-theme-spacing-normal, 0.75rem);
        border-radius: var(
          --ct-theme-border-radius,
          var(--ct-border-radius-sm, 0.25rem)
        );
        overflow: auto;
        max-height: 300px;
        margin: 0;
        font-size: 0.9rem;
        font-family: monospace;
      }

      .oauth-button.logout {
        background-color: var(
          --ct-theme-color-error,
          var(--ct-color-red-600, #dc2626)
        );
      }

      .oauth-button.logout:hover {
        background-color: var(
          --ct-theme-color-error,
          var(--ct-color-red-700, #b91c1c)
        );
      }
    `,
  ];
}

globalThis.customElements.define("ct-google-oauth", CTGoogleOauth);
