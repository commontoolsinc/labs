import { css, html, LitElement } from "lit";
import { property } from "lit/decorators.js";
import type { DiscoveredLink } from "@commontools/runner";
import { createLLMFriendlyLink } from "@commontools/runner";
import "@commontools/ui";

/**
 * XLinksBar - Displays discovered links from a cell as a toggleable bar
 *
 * @element x-links-bar
 *
 * @property {DiscoveredLink[]} links - Array of discovered links to display
 * @property {boolean} collapsed - Whether the bar is collapsed (default: true)
 *
 * @example
 * <x-links-bar .links=${discoveredLinks}></x-links-bar>
 */
export class XLinksBar extends LitElement {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
      border-bottom: var(--border-width, 2px) solid var(--border-color, #000);
      background-color: var(--header-bg-color, #f9fafb);
    }

    .links-header {
      display: flex;
      align-items: center;
      padding: 0.5rem;
      cursor: pointer;
      user-select: none;
      transition: background-color 0.2s;
    }

    .links-header:hover {
      background-color: rgba(0, 0, 0, 0.05);
    }

    .toggle-button {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-family: var(--font-primary);
      font-size: 0.875rem;
      font-weight: 600;
      color: var(--text-primary, #000);
      background: none;
      border: none;
      padding: 0;
      cursor: pointer;
    }

    .toggle-icon {
      transition: transform 0.2s ease;
      font-size: 0.75rem;
    }

    .toggle-icon.expanded {
      transform: rotate(90deg);
    }

    .links-count {
      opacity: 0.6;
      font-weight: 400;
    }

    .links-content {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      padding: 0 0.5rem 0.5rem 0.5rem;
      overflow-x: auto;
    }

    .links-content.collapsed {
      display: none;
    }

    .no-links {
      padding: 0.5rem;
      font-size: 0.875rem;
      color: var(--text-secondary, #666);
      font-style: italic;
    }

    ct-cell-link {
      flex-shrink: 0;
    }
  `;

  @property({ type: Array })
  links: DiscoveredLink[] = [];

  @property({ type: Boolean })
  collapsed = true;

  private _toggle() {
    this.collapsed = !this.collapsed;
  }

  override render() {
    const linkCount = this.links.length;
    const hasLinks = linkCount > 0;

    return html`
      <div class="links-header" @click="${this._toggle}">
        <button class="toggle-button" aria-expanded="${!this.collapsed}">
          <span class="toggle-icon ${this.collapsed ? "" : "expanded"}">
            ▶
          </span>
          <span>Links</span>
          <span class="links-count">(${linkCount})</span>
        </button>
      </div>
      ${!this.collapsed
        ? html`
          <div class="links-content">
            ${hasLinks
              ? this.links.map((discoveredLink) => {
                // Convert NormalizedFullLink to LLM-friendly string format
                const linkString = createLLMFriendlyLink(
                  discoveredLink.link,
                );
                return html`
                  <ct-cell-link .link="${linkString}"></ct-cell-link>
                `;
              })
              : html`
                <div class="no-links">No links found</div>
              `}
          </div>
        `
        : ""}
    `;
  }
}

globalThis.customElements.define("x-links-bar", XLinksBar);

declare global {
  interface HTMLElementTagNameMap {
    "x-links-bar": XLinksBar;
  }
}
