import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { baseStyles } from "./style.js";

export type CommonSecret = {
  id: string;
  value: string;
};

export class CommonSecretEvent extends Event {
  detail: CommonSecret;

  constructor(detail: CommonSecret) {
    super("common-secret", { bubbles: true, composed: true });
    this.detail = detail;
  }
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const pemHeader = "-----BEGIN PUBLIC KEY-----";
  const pemFooter = "-----END PUBLIC KEY-----";
  let pemContents = pem.replace(pemHeader, "").replace(pemFooter, "");
  pemContents = pemContents.replace(/\s/g, "");
  const binaryString = window.atob(pemContents);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

async function importPublicKey(pemKey: string): Promise<CryptoKey> {
  const binaryDer = pemToArrayBuffer(pemKey);
  return window.crypto.subtle.importKey(
    "spki",
    binaryDer,
    {
      name: "RSA-OAEP",
      hash: "SHA-256",
    },
    false,
    ["encrypt"],
  );
}

// Helper: Convert an ArrayBuffer to a base64-encoded string.
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

@customElement("common-secret")
export class CommonSecretElement extends LitElement {
  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
        --height: 24px;
      }
      .input-wrapper {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .input-group {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .input {
        appearance: none;
        border: 1px solid var(--border-color, #ccc);
        outline: none;
        box-sizing: border-box;
        font-size: var(--body-size, 14px);
        width: 100%;
        height: var(--height);
        padding: 4px 8px;
      }
      :host([appearance="rounded"]) .input {
        border-radius: calc(var(--height) / 2);
      }
      button {
        padding: 4px 12px;
        font-size: var(--body-size, 14px);
        cursor: pointer;
        transition:
          opacity 0.2s,
          background-color 0.2s;
      }
      button:disabled {
        cursor: not-allowed;
        opacity: 0.6;
      }
      .input:focus {
        border-color: var(--focus-color, #0066cc);
        box-shadow: 0 0 0 2px var(--focus-ring-color, rgba(0, 102, 204, 0.2));
      }
      .input:disabled {
        background-color: var(--disabled-bg, #f5f5f5);
        cursor: not-allowed;
      }
      .warning {
        color: red;
        font-size: 0.9em;
      }
    `,
  ];

  @property({ type: String }) value = "";
  @property({ type: String }) placeholder = "Enter secret";
  @property({ type: String }) appearance = "default";
  /**
   * The RSA public key in PEM format (base64-encoded with BEGIN/END markers).
   * Example:
   * -----BEGIN PUBLIC KEY-----
   * MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...
   * -----END PUBLIC KEY-----
   */
  @property({ type: String, attribute: "pubkey" })
  get pubkey() {
    return this._pubkey || CommonSecretElement.PUBLIC_KEY;
  }
  set pubkey(value: string) {
    const oldValue = this._pubkey;
    this._pubkey = value;
    // Clear cached key when pubkey changes
    if (oldValue !== value) {
      this._importedPublicKey = null;
    }
    this.requestUpdate("pubkey", oldValue);
  }
  private _pubkey = "";

  // Cache the imported public key.
  private _importedPublicKey: CryptoKey | null = null;

  // Add static property for global public key
  static PUBLIC_KEY: string;

  private async getImportedPublicKey(): Promise<CryptoKey> {
    if (this._importedPublicKey) {
      return this._importedPublicKey;
    }
    if (!this.pubkey) {
      throw new Error("Public key not provided");
    }
    this._importedPublicKey = await importPublicKey(this.pubkey);
    return this._importedPublicKey;
  }

  private async encryptValue(value: string): Promise<string> {
    if (!this.pubkey) {
      throw new Error("Public key not provided");
    }
    try {
      const key = await this.getImportedPublicKey();
      const encoded = new TextEncoder().encode(value);
      const ciphertextBuffer = await window.crypto.subtle.encrypt(
        { name: "RSA-OAEP" },
        key,
        encoded,
      );
      return arrayBufferToBase64(ciphertextBuffer);
    } catch (err) {
      throw new Error("Encryption failed", { cause: err });
    }
  }

  // When the user clicks "Set", encrypt the value and emit it.
  private async onSetClick() {
    const inputEl = this.shadowRoot?.querySelector(".input") as HTMLInputElement;
    if (!inputEl) return;
    this.value = inputEl.value;
    const encryptedValue = await this.encryptValue(this.value);
    this.dispatchEvent(new CommonSecretEvent({ id: this.id, value: encryptedValue }));
  }

  private get isInputEmpty(): boolean {
    return !this.value;
  }

  private handleInput(e: Event) {
    const input = e.target as HTMLInputElement;
    this.value = input.value;
  }

  override render() {
    return !this.pubkey
      ? html`<div class="warning">No public key provided</div>`
      : html`<div class="input-group">
          <input
            class="input"
            .value="${this.value}"
            placeholder="${this.placeholder}"
            type="password"
            @input="${this.handleInput}"
            aria-label="Secret value input"
          />
          <button
            @click="${this.onSetClick}"
            ?disabled="${this.isInputEmpty}"
            aria-label="Set secret value"
          >
            Save Secret
          </button>
        </div> `;
  }
}
