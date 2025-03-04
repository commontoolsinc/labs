import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { baseStyles } from "./style.js";

@customElement("common-google-oauth")
export class CommonGoogleOauthElement extends LitElement {
  @property({ type: Object })
  accessor auth: Record<string, unknown> = {};
  @property({ type: Object })
  accessor authCell: Record<string, unknown> = {};

  @property({ type: String })
  accessor authStatus: string = "";
  @property({ type: Boolean })
  accessor isLoading: boolean = false;
  @property({ type: Object })
  accessor authResult: Record<string, unknown> | null = null;

  async handleClick() {
    this.isLoading = true;
    this.authStatus = "Initiating OAuth flow...";
    this.authResult = null;

    let authCellId = JSON.parse(JSON.stringify(this.authCell, null, 2));
    authCellId.space = location.pathname.split("/")[1];
    authCellId = JSON.stringify(authCellId);

    const payload = {
      authCellId,
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
      console.log("OAuth URL:", resp.url);
      this.authStatus = "Opening OAuth window...";

      // TODO(jesse): do we need this? Since we have a cell
      // Create a message listener for the OAuth callback
      const messageListener = (event: MessageEvent) => {
        // Verify origin for security
        if (event.origin !== globalThis.location.origin) return;

        if (event.data && event.data.type === "oauth-callback") {
          console.log("Received OAuth callback data:", event.data);
          this.authResult = event.data.result;
          this.authStatus = event.data.result.success
            ? "Authentication successful!"
            : `Authentication failed: ${event.data.result.error || "Unknown error"}`;
          this.isLoading = false;
          globalThis.removeEventListener("message", messageListener);
        }
      };

      globalThis.addEventListener("message", messageListener);

      // Open the OAuth window
      const authWindow = globalThis.open(resp.url, "_blank", "width=800,height=600,left=200,top=200");

      // Check for window closure
      if (authWindow) {
        const checkWindowClosed = setInterval(() => {
          if (authWindow.closed) {
            clearInterval(checkWindowClosed);
            if (!this.authResult) {
              this.authStatus = "OAuth window closed. Authentication may not have completed.";
              this.isLoading = false;
            }
            globalThis.removeEventListener("message", messageListener);
          }
        }, 500);
      }
    } catch (error: unknown) {
      console.error("OAuth error:", error);
      this.authStatus = `Error: ${error instanceof Error ? error.message : String(error)}`;
      this.isLoading = false;
    }
  }

  override render() {
    return html`
      <div class="oauth-wrapper">
        <h2>Google OAuth</h2>
        <pre class="auth-data">Auth data: ${JSON.stringify(this.auth, null, 2)}</pre>

        <button @click=${this.handleClick} ?disabled=${this.isLoading} class="oauth-button">
          ${this.isLoading ? "Processing..." : "Authenticate with Google"}
        </button>

        ${this.authStatus ? html`<div class="status-message">${this.authStatus}</div>` : ""}
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
          padding: 16px;
          border-radius: 8px;
          background-color: #f5f5f5;
          max-width: 600px;
        }

        .auth-data {
          background-color: #eaeaea;
          padding: 8px;
          border-radius: 4px;
          overflow: auto;
          max-height: 150px;
        }

        .oauth-button {
          background-color: #4285f4;
          color: white;
          border: none;
          padding: 10px 16px;
          border-radius: 4px;
          cursor: pointer;
          font-weight: bold;
          margin-top: 16px;
        }

        .oauth-button:hover {
          background-color: #3367d6;
        }

        .oauth-button:disabled {
          background-color: #cccccc;
          cursor: not-allowed;
        }

        .status-message {
          margin-top: 16px;
          padding: 8px;
          border-radius: 4px;
          background-color: #e8f0fe;
          color: #1a73e8;
        }

        .auth-result {
          margin-top: 16px;
          padding: 8px;
          border-radius: 4px;
          background-color: #f0f8ff;
        }

        .auth-result pre {
          background-color: #eaeaea;
          padding: 8px;
          border-radius: 4px;
          overflow: auto;
          max-height: 300px;
        }
      `,
    ];
  }
}
