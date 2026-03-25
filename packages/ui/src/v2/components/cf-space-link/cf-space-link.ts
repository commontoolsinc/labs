import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";
import "../cf-chip/cf-chip.ts";
import type { DID } from "@commonfabric/identity";
import { navigate } from "@commonfabric/shell/shared";

/**
 * CFSpaceLink - Renders a space as a clickable pill that navigates to the space
 *
 * @element cf-space-link
 *
 * @property {string} spaceName - The human-readable space name (optional)
 * @property {DID} spaceDid - The space DID (required for navigation fallback)
 * @property {string} label - Custom display text (optional)
 *
 * @example
 * <cf-space-link spaceName="my-space"></cf-space-link>
 * <cf-space-link spaceDid="did:key:z6Mk..."></cf-space-link>
 * <cf-space-link spaceName="my-space" spaceDid="did:key:z6Mk..." label="My Space"></cf-space-link>
 */
export class CFSpaceLink extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: inline-block;
        vertical-align: middle;
      }

      cf-chip {
        cursor: pointer;
        max-width: 100%;
      }
    `,
  ];

  @property({ type: String })
  spaceName?: string;

  @property({ type: String })
  spaceDid?: DID;

  @property({ type: String })
  label?: string;

  private _truncateDid(did: string): string {
    if (did.length <= 20) return did;
    return `${did.slice(0, 10)}...${did.slice(-6)}`;
  }

  private _handleClick(e: Event) {
    e.stopPropagation();

    if (this.spaceName) {
      navigate({ spaceName: this.spaceName });
    } else if (this.spaceDid) {
      navigate({ spaceDid: this.spaceDid });
    }
  }

  override render() {
    // Priority: label > spaceName > truncated spaceDid > "Unknown Space"
    const displayText = this.label
      ? this.label
      : this.spaceName
      ? this.spaceName
      : this.spaceDid
      ? this._truncateDid(this.spaceDid)
      : "Unknown Space";

    return html`
      <cf-chip
        variant="primary"
        interactive
        @click="${this._handleClick}"
      >
        ${displayText}
      </cf-chip>
    `;
  }
}

globalThis.customElements.define("cf-space-link", CFSpaceLink);

declare global {
  interface HTMLElementTagNameMap {
    "cf-space-link": CFSpaceLink;
  }
}
