import { css, html, LitElement } from "lit";
import { baseStyles } from "./style.ts";
import { Cell } from "@commontools/runner";
import { CommonCharmElement } from "./common-charm.ts";

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

export class CommonGoogleOauthElement extends LitElement {
  static override properties = {
    auth: { type: Object },
    authStatus: { type: String },
    isLoading: { type: Boolean },
    authResult: { type: Object },
    scopes: { type: Array },
  };

  declare auth: Cell<AuthData> | undefined;
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

    const authCellId = JSON.stringify(this.auth?.getAsLink());

    // `ct://${spaceDid}/${cellId}`

    // FIXME(jake): This is a hack to get the charm id that mounts this web component.
    // Once we have multi-charm urls, this will break!
    // It would be nice if our common ui web components knew which charm is mounting them...
    const container = CommonCharmElement.findCharmContainer(this);
    if (!container) {
      throw new Error("No <common-charm> container.");
    }
    const { charmId } = container;
    const payload = {
      authCellId,
      integrationCharmId: charmId,
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

      // TODO(jesse): do we need this? Since we have a cell
      // Create a message listener for the OAuth callback
      const messageListener = (event: MessageEvent) => {
        // Verify origin for security
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

      // Open the OAuth window
      const authWindow = globalThis.open(
        resp.url,
        "_blank",
        "width=800,height=800,left=200,top=200",
      );

      // Check for window closure
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
    await this.auth?.set({
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
          ${this.auth?.get()?.user?.email && this.auth?.get()?.token
        ? html`
          <img class="profile-picture" src="${this.auth?.get()?.user
            ?.picture}" alt="User profile picture" />
          <div class="user-info">
            <h2 class="user-name">${this.auth?.get()?.user?.name}</h2>
            <p class="user-email">${this.auth?.get()?.user?.email}</p>
          </div>
        `
        : ""}
        </div>

        <div class="action-section">
          ${this.auth?.get()?.token
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

  static override get styles() {
    return [
      baseStyles,
      css`
        .oauth-wrapper {
          padding: 24px;
          border-radius: 12px;
          background-color: #ffffff;
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
          max-width: 600px;
        }

        .profile-section {
          display: flex;
          align-items: center;
          gap: 20px;
          margin-bottom: 24px;
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
          color: #333;
        }

        .user-email {
          margin: 4px 0 0;
          color: #666;
        }

        .action-section {
          display: flex;
          flex-direction: column;
          gap: 16px;
          margin-bottom: 24px;
        }

        .oauth-button {
          background-color: #4285f4;
          color: white;
          border: none;
          padding: 12px 24px;
          border-radius: 6px;
          cursor: pointer;
          font-weight: 500;
          font-size: 1rem;
          transition: background-color 0.2s ease;
        }

        .oauth-button:hover {
          background-color: #3367d6;
        }

        .oauth-button:disabled {
          background-color: #cccccc;
          cursor: not-allowed;
        }

        .status-message {
          padding: 12px;
          border-radius: 6px;
          background-color: #e8f0fe;
          color: #1a73e8;
          font-size: 0.9rem;
        }

        .auth-result {
          background-color: #f8f9fa;
          padding: 16px;
          border-radius: 8px;
        }

        .auth-result h3 {
          margin: 0 0 12px;
          color: #333;
        }

        .auth-result pre {
          background-color: #f1f3f4;
          padding: 12px;
          border-radius: 6px;
          overflow: auto;
          max-height: 300px;
          margin: 0;
          font-size: 0.9rem;
        }

        .oauth-button.logout {
          background-color: #dc3545;
        }

        .oauth-button.logout:hover {
          background-color: #c82333;
        }
      `,
    ];
  }
}
globalThis.customElements.define(
  "common-google-oauth",
  CommonGoogleOauthElement,
);
