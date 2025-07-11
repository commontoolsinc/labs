import { css, html } from "lit";
import { state } from "lit/decorators.js";

import { Identity } from "@commontools/identity";

import { BaseView } from "./BaseView.ts";
import {
  AUTH_METHOD_PASSKEY,
  AUTH_METHOD_PASSPHRASE,
  type AuthMethod,
  clearStoredCredential,
  createPasskeyCredential,
  createPassphraseCredential,
  getPublicKeyCredentialDescriptor,
  getStoredCredential,
  saveCredential,
  type StoredCredential,
} from "../lib/credentials.ts";

type AuthFlow = "register" | "login";

export class XLoginView extends BaseView {
  static override styles = css`
    :host {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      height: 100%;
      font-family: var(--font-primary);
    }

    .login-container {
      display: flex;
      flex-direction: column;
      align-items: center;
    }

    .auth-action-container {
      width: 100%;
      max-width: 600px;
      padding: 2rem;
      background: white;
      border: var(--border-width, 2px) solid var(--border-color, #000);
    }

    .logo-container {
      display: flex;
      justify-content: center;
      margin-bottom: 2rem;
    }

    .logo {
      width: 80px;
      height: 80px;
    }

    button {
      width: 100%;
      padding: 0.75rem 1rem;
      margin-bottom: 0.5rem;
      font-family: var(--font-primary);
      background-color: white;
      border: var(--border-width, 2px) solid var(--border-color, #000);
      cursor: pointer;
      transition: all 0.1s ease-in-out;
    }

    button:hover:not(:disabled) {
      transform: translateY(-2px);
      box-shadow: 2px 2px 0px 0px rgba(0, 0, 0, 0.5);
    }

    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    button.primary {
      background-color: black;
      color: white;
    }

    button.primary:hover:not(:disabled) {
      background-color: #333;
    }

    .method-list button {
      text-align: left;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    input, textarea {
      width: 100%;
      padding: 0.75rem 1rem;
      margin-bottom: 0.5rem;
      font-family: var(--font-primary);
      font-size: 1rem;
      border: var(--border-width, 2px) solid var(--border-color, #000);
      background: white;
      box-sizing: border-box;
    }

    textarea {
      resize: none;
      min-height: 4rem;
    }

    .message {
      padding: 1rem;
      margin-bottom: 1rem;
      background-color: #f5f5f5;
    }

    .message p {
      margin: 0;
    }

    .error {
      padding: 1rem;
      margin-bottom: 1rem;
      background-color: #fee;
      border-left: 4px solid #f00;
      color: #800;
    }

    .success {
      background-color: #efe;
      border-left: 4px solid #0a0;
      color: #080;
    }

    .mnemonic-display {
      position: relative;
      margin-bottom: 1rem;
      padding: 1rem;
      background-color: #f5f5f5;
      border: var(--border-width, 2px) solid var(--border-color, #000);
    }

    .mnemonic-text {
      font-family: monospace;
      font-size: 1rem;
      line-height: 1.5;
      padding-right: 80px;
      word-break: break-word;
    }

    .copy-button {
      position: absolute;
      right: 0.5rem;
      top: 0.5rem;
      padding: 0.25rem 0.5rem;
      font-size: 0.875rem;
      width: auto;
      margin: 0;
    }

    .info-text {
      font-size: 0.875rem;
      color: #666;
      margin-bottom: 1rem;
    }

    h2 {
      margin: 0 0 1rem 0;
      font-size: 1.25rem;
    }

    .button-row {
      display: flex;
      gap: 0.5rem;
    }

    .button-row button {
      flex: 1;
    }

    .login-row {
      display: flex;
      gap: 0.5rem;
      align-items: center;
      margin-bottom: 0.5rem;
    }

    .login-row .primary {
      flex: 1;
      margin-bottom: 0;
    }

    .delete-button {
      width: auto;
      min-width: 3rem;
      padding: 0.75rem;
      margin-bottom: 0;
      flex-shrink: 0;
    }

    .loading {
      text-align: center;
      padding: 2rem;
    }

    .stored-credential-info {
      font-size: 0.875rem;
      color: #666;
    }
  `;

  @state()
  private flow: AuthFlow | null = null;
  @state()
  private method: AuthMethod | null = null;
  @state()
  private error: string | null = null;
  @state()
  private mnemonic: string | null = null;
  @state()
  private isProcessing = false;
  @state()
  private registrationSuccess = false;
  @state()
  private storedCredential: StoredCredential | null = getStoredCredential();
  @state()
  private copied = false;

  private availableMethods: AuthMethod[] = [];

  override connectedCallback() {
    super.connectedCallback();
    this.checkAvailableMethods();
  }

  private checkAvailableMethods() {
    const methods: AuthMethod[] = [];

    // Check if passkeys are available (not on localhost, WebAuthn available)
    const isPasskeyAvailable = globalThis.location.hostname !== "localhost" &&
      globalThis.PublicKeyCredential !== undefined;

    if (isPasskeyAvailable) {
      methods.push(AUTH_METHOD_PASSKEY);
    }

    // Passphrase always available
    methods.push(AUTH_METHOD_PASSPHRASE);

    this.availableMethods = methods;

    // If only one method available, pre-select it
    if (methods.length === 1) {
      this.method = methods[0];
    }
  }

  private async handleAuth<T>(
    action: () => Promise<T>,
  ): Promise<T | undefined> {
    console.log("[LoginView] Starting auth process:", {
      flow: this.flow,
      method: this.method,
      timestamp: new Date().toISOString(),
    });

    try {
      this.error = null;
      this.isProcessing = true;
      const result = await action();
      console.log("[LoginView] Auth action completed successfully");
      return result;
    } catch (e) {
      console.error("[LoginView] Auth error:", e);
      this.error = e instanceof Error ? e.message : "Authentication failed";
      this.flow = null;
      this.method = null;
      return undefined;
    } finally {
      this.isProcessing = false;
    }
  }

  private async handleRegister() {
    if (this.method === AUTH_METHOD_PASSKEY) {
      await this.handleAuth(() => {
        this.command({
          type: "passkey-register",
          name: "Common Tools User",
          displayName: "commontoolsuser",
        });
        // Note: We'll need to handle the passkey ID return differently
        this.registrationSuccess = true;
      });
    } else {
      // For passphrase, we need to generate and display the mnemonic
      const result = await this.handleAuth(async () => {
        const [, mnemonic] = await Identity.generateMnemonic();
        this.mnemonic = mnemonic;
        return mnemonic;
      });
    }
  }

  private async handleLogin(passphrase?: string) {
    console.log("[LoginView] Handling login:", {
      method: this.method,
      hasPassphrase: !!passphrase,
      hasStoredCredential: !!this.storedCredential,
    });

    if (this.method === AUTH_METHOD_PASSKEY) {
      const descriptor = getPublicKeyCredentialDescriptor(
        this.storedCredential,
      );
      await this.handleAuth(() => {
        console.log("[LoginView] Sending passkey-authenticate command");
        this.command({
          type: "passkey-authenticate",
          descriptor,
        });
      });
    } else if (passphrase) {
      await this.handleAuth(() => {
        console.log("[LoginView] Authenticating with passphrase");
        this.command({
          type: "passphrase-authenticate",
          mnemonic: passphrase,
        });

        // Store credential indicator
        if (!this.storedCredential) {
          const credential = createPassphraseCredential();
          saveCredential(credential);
          this.storedCredential = credential;
        }
      });
    }
  }

  private async copyToClipboard() {
    if (this.mnemonic) {
      await navigator.clipboard.writeText(this.mnemonic);
      this.copied = true;
      setTimeout(() => this.copied = false, 2000);
    }
  }

  private renderInitial() {
    if (this.storedCredential) {
      const isPassphrase =
        this.storedCredential.method === AUTH_METHOD_PASSPHRASE;
      const isPasskeyAvailable = this.availableMethods.includes(
        AUTH_METHOD_PASSKEY,
      );

      return html`
        ${!isPassphrase
          ? html`
            <div class="login-row">
              <button
                class="primary"
                @click="${() => this.handleQuickUnlock()}"
              >
                🔒 Login with Passkey (${this.storedCredential.id.slice(-4)})
              </button>
              <button
                class="delete-button"
                @click="${() => {
              clearStoredCredential();
              this.storedCredential = null;
            }}"
                title="Remove saved credential"
              >
                🗑️
              </button>
            </div>
          `
          : html`
            <button
              class="primary"
              @click="${() => this.handleQuickUnlock()}"
            >
              🔒 Login with Passphrase
            </button>
          `}
        <div class="button-row">
          ${isPassphrase && isPasskeyAvailable
          ? html`
            <button @click="${async () => {
              this.flow = "login";
              this.method = AUTH_METHOD_PASSKEY;
              await this.handleLogin();
            }}">
              🔑 Login w/ Passkey
            </button>
          `
          : !isPassphrase
          ? html`
            <button @click="${() => {
              this.flow = "login";
              this.method = AUTH_METHOD_PASSPHRASE;
            }}">
              🔑 Login w/ Passphrase
            </button>
          `
          : null}
          <button @click="${() => this.flow = "register"}">
            ➕ Register New Key
          </button>
        </div>
      `;
    }

    return html`
      <button class="primary" @click="${() => this.flow = "register"}">
        ➕ Register
      </button>
      <button class="primary" @click="${() => this.flow = "login"}">
        🔒 Login
      </button>
    `;
  }

  private async handleQuickUnlock() {
    if (!this.storedCredential) return;

    this.method = this.storedCredential.method;
    this.flow = "login";

    if (this.storedCredential.method === AUTH_METHOD_PASSKEY) {
      await this.handleLogin();
    }
  }

  private renderMethodSelection() {
    return html`
      <h2>${this.flow === "login" ? "Login with" : "Register with"}</h2>
      <div class="method-list">
        ${this.availableMethods.map((method) =>
        html`
          <button @click="${() => this.handleMethodSelect(method)}">
            ${method === AUTH_METHOD_PASSKEY
            ? "🔑 Use Passkey"
            : "📝 Use Passphrase"}
          </button>
        `
      )}
      </div>
      <button @click="${() => {
        this.flow = null;
        this.method = null;
      }}">
        ← Back
      </button>
    `;
  }

  private async handleMethodSelect(method: AuthMethod) {
    this.method = method;
    if (this.flow === "register") {
      await this.handleRegister();
    } else if (this.flow === "login" && method === AUTH_METHOD_PASSKEY) {
      await this.handleLogin();
    }
  }

  private renderPassphraseAuth() {
    if (this.flow === "register") {
      if (this.mnemonic) {
        return this.renderMnemonicDisplay();
      }
      return html`
        <button class="primary" @click="${() => this.handleRegister()}">
          🔑 Generate Passphrase
        </button>
        <button @click="${() => {
          this.flow = null;
          this.method = null;
        }}">
          ← Back
        </button>
      `;
    }

    return html`
      <form @submit="${this.handlePassphraseLogin}">
        <input
          type="password"
          name="passphrase"
          placeholder="Enter your passphrase"
          autocomplete="current-password"
          required
        />
        <button type="submit" class="primary">
          🔒 Login
        </button>
      </form>
      <button @click="${() => {
        this.flow = null;
        this.method = null;
      }}">
        ← Back
      </button>
    `;
  }

  private handlePassphraseLogin = (e: Event) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const formData = new FormData(form);
    const passphrase = formData.get("passphrase") as string;
    this.handleLogin(passphrase);
  };

  private renderMnemonicDisplay() {
    return html`
      <div class="message success">
        <p>Your Secret Recovery Phrase:</p>
      </div>
      <div class="mnemonic-display">
        <button
          class="copy-button"
          @click="${this.copyToClipboard}"
        >
          ${this.copied ? "✓ Copied" : "📋 Copy"}
        </button>
        <div class="mnemonic-text">
          ${this.mnemonic || ""}
        </div>
      </div>
      <p class="info-text">
        ⚠️ Keep this secret, it's your password.
      </p>
      <button
        class="primary"
        @click="${() => {
        this.mnemonic = null;
        this.flow = "login";
      }}"
      >
        🔒 Continue to Login
      </button>
    `;
  }

  private renderSuccess() {
    return html`
      <div class="success">
        <p>✓ ${this.method === AUTH_METHOD_PASSKEY
        ? "Passkey"
        : "Passphrase"} successfully registered!</p>
      </div>
      <button
        class="primary"
        @click="${() => {
        this.registrationSuccess = false;
        this.flow = "login";
      }}"
      >
        🔒 Continue to Login
      </button>
    `;
  }

  override render() {
    return html`
      <div class="login-container">
        <div class="logo-container">
          <ct-logo
            background-color="black"
            shape-color="white"
            width="100"
            height="100"
          ></ct-logo>
        </div>

        <div class="auth-action-container">
          ${this.error
        ? html`
          <div class="error">
            ${this.error}
          </div>
        `
        : ""} ${this.isProcessing
        ? html`
          <div class="loading">
            <p>Please follow the browser's prompts to continue...</p>
          </div>
        `
        : this.mnemonic
        ? this.renderMnemonicDisplay()
        : this.registrationSuccess
        ? this.renderSuccess()
        : this.flow === null
        ? this.renderInitial()
        : this.method === null
        ? this.renderMethodSelection()
        : this.method === AUTH_METHOD_PASSPHRASE
        ? this.renderPassphraseAuth()
        : this.method === AUTH_METHOD_PASSKEY
        ? html`
          <div class="loading">
            <p>Please follow the browser's prompts to continue...</p>
          </div>
        `
        : ""}
        </div>
      </div>
    `;
  }
}

globalThis.customElements.define("x-login-view", XLoginView);
