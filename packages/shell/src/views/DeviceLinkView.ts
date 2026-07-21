import { css, html, LitElement } from "lit";
import { property, state } from "lit/decorators.js";

// The confirm gate for device-link login (`#k=` — see ../lib/device-link.ts).
//
// WHY A CONFIRM AT ALL: the payload donates a private key. An attacker who
// gets someone to open `…/home#k=<attacker-entropy>` — a crafted link, a QR
// sticker over a real one — would otherwise silently sign the victim in AS the
// attacker, so everything they then write lands in the attacker's space and
// their own session is gone. Scanning steals nothing directly (there is no
// exfiltration channel; the payload gives away the attacker's own key), which
// makes this screen the entire defence. Hence the DID shown prominently for
// cross-checking against the Pair screen, and copy that tells the user what
// the code is supposed to have come from.
//
// INTERIM: delete this along with the rest of the device-link flow when key
// delegation lands.
export class XDeviceLinkView extends LitElement {
  static override styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 1000;
      display: grid;
      place-items: center;
      background: var(--bg, #fff);
      color: var(--text, #111);
      font: 16px/1.5 system-ui, sans-serif;
      padding: 1.5rem;
      box-sizing: border-box;
    }
    .card {
      max-width: 30rem;
      width: 100%;
    }
    h1 {
      font-size: 1.25rem;
      margin: 0 0 0.75rem;
    }
    .did {
      font-family: ui-monospace, monospace;
      font-size: 0.95rem;
      word-break: break-all;
      background: rgba(127, 127, 127, 0.12);
      border-radius: 0.375rem;
      padding: 0.6rem 0.75rem;
      margin: 0.5rem 0 1rem;
    }
    .label {
      font-size: 0.8rem;
      opacity: 0.7;
      margin-bottom: 0.15rem;
    }
    .warn {
      font-size: 0.9rem;
      opacity: 0.85;
      margin: 0 0 1.25rem;
    }
    .actions {
      display: flex;
      gap: 0.75rem;
      flex-wrap: wrap;
    }
    button {
      font: inherit;
      padding: 0.55rem 1.1rem;
      border-radius: 0.375rem;
      border: 1px solid currentColor;
      background: transparent;
      color: inherit;
      cursor: pointer;
    }
    button.primary {
      background: currentColor;
      border-color: transparent;
    }
    button.primary span {
      color: var(--bg, #fff);
    }
  `;

  /** DID the scanned code would sign as. */
  @property({ attribute: false })
  accessor incomingDid = "";

  /** DID already signed in on this device, when different. */
  @property({ attribute: false })
  accessor currentDid: string | null = null;

  @state()
  private accessor busy = false;

  private finish(accepted: boolean) {
    if (this.busy) return;
    this.busy = true;
    this.dispatchEvent(
      new CustomEvent("device-link-result", { detail: { accepted } }),
    );
  }

  override render() {
    const replacing = this.currentDid !== null &&
      this.currentDid !== this.incomingDid;
    const alreadySignedIn = this.currentDid === this.incomingDid;

    if (alreadySignedIn) {
      return html`
        <div class="card">
          <h1>Already signed in</h1>
          <div class="label">Identity</div>
          <div class="did">${this.incomingDid}</div>
          <div class="actions">
            <button class="primary" @click="${() => this.finish(true)}">
              <span>Continue</span>
            </button>
          </div>
        </div>
      `;
    }

    return html`
      <div class="card">
        <h1>${replacing
          ? "Replace current identity?"
          : "Use this identity?"}</h1>
        ${replacing
          ? html`
            <div class="label">Currently signed in as</div>
            <div class="did">${this.currentDid}</div>
          `
          : ""}
        <div class="label">${replacing ? "Would become" : "Sign in as"}</div>
        <div class="did">${this.incomingDid}</div>
        <p class="warn">
          Only continue if this code was just revealed on the Pair screen of a device
          that belongs here, and the identity above matches the one shown
          there.${replacing
            ? " The identity currently signed in on this device will be replaced."
            : ""}
        </p>
        <div class="actions">
          <button class="primary" @click="${() => this.finish(true)}">
            <span>${replacing ? "Replace identity" : "Continue"}</span>
          </button>
          <button @click="${() => this.finish(false)}">Cancel</button>
        </div>
      </div>
    `;
  }
}

globalThis.customElements.define("x-device-link-view", XDeviceLinkView);

declare global {
  interface HTMLElementTagNameMap {
    "x-device-link-view": XDeviceLinkView;
  }
}
