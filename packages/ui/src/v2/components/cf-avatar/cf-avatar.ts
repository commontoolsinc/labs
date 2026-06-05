import { css, html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";
import { oneOf } from "../../core/property-guards.ts";

export type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl";
export type AvatarShape = "circle" | "square";

const avatarSizes = ["xs", "sm", "md", "lg", "xl"] as const;
const avatarShapes = ["circle", "square"] as const;

/**
 * Returns true when `src` looks like something an `<img>` can load (http(s):,
 * data:, blob:, or a root-relative path). A non-URL string (e.g. an emoji or a
 * couple of letters) is rendered as a glyph instead.
 */
export const isAvatarImageUrl = (src: string): boolean =>
  /^(https?:|data:|blob:|\/)/i.test(src.trim());

/** Up to two uppercase initials derived from a display name. */
export const initialsForName = (name: string | undefined): string => {
  if (!name) return "?";
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase())
    .join("")
    .slice(0, 2);
  return initials || "?";
};

/**
 * CFAvatar — generic avatar primitive: image, glyph, or initials fallback.
 *
 * Presentation only; it carries NO trust claims, so any code — including
 * sandboxed user-space patterns — may render it. The trusted, profile-cell-bound
 * identity presentation lives in `<cf-profile-badge>`, which composes this.
 *
 * Rendering precedence:
 *   1. `src` that looks like a URL  → `<img>` (falls back to initials on error)
 *   2. `src` that is a short glyph  → the glyph as-is (e.g. an emoji)
 *   3. otherwise                    → initials derived from `name`
 *
 * @element cf-avatar
 * @attr {string} src   - Image URL, or a glyph/emoji string
 * @attr {string} name  - Display name; drives the initials fallback + alt text
 * @attr {string} alt   - Explicit alt text (defaults to `name`)
 * @attr {string} size  - xs | sm | md | lg | xl (default md)
 * @attr {string} shape - circle | square (default circle)
 */
export class CFAvatar extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        --cf-avatar-size: 2rem;
        --cf-avatar-font-size: 0.8125rem;
        --cf-avatar-bg: var(--cf-theme-color-secondary, hsl(0, 0%, 92%));
        --cf-avatar-fg: var(
          --cf-theme-color-secondary-foreground,
          hsl(0, 0%, 25%)
        );
        display: inline-block;
        vertical-align: middle;
      }

      :host([size="xs"]) {
        --cf-avatar-size: 1.25rem;
        --cf-avatar-font-size: 0.5625rem;
      }
      :host([size="sm"]) {
        --cf-avatar-size: 1.5rem;
        --cf-avatar-font-size: 0.6875rem;
      }
      /* md is the default — no override */
      :host([size="lg"]) {
        --cf-avatar-size: 2.75rem;
        --cf-avatar-font-size: 1rem;
      }
      :host([size="xl"]) {
        --cf-avatar-size: 4rem;
        --cf-avatar-font-size: 1.5rem;
      }

      .avatar {
        box-sizing: border-box;
        width: var(--cf-avatar-size);
        height: var(--cf-avatar-size);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        background: var(--cf-avatar-bg);
        color: var(--cf-avatar-fg);
        font-size: var(--cf-avatar-font-size);
        font-weight: var(--cf-font-weight-semibold, 600);
        line-height: 1;
        user-select: none;
        border-radius: var(--cf-border-radius-full, 9999px);
      }

      :host([shape="square"]) .avatar {
        border-radius: var(--cf-border-radius-md, 6px);
      }

      .avatar img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }

      .glyph {
        font-size: calc(var(--cf-avatar-font-size) * 1.4);
      }
    `,
  ];

  @property({ type: String })
  accessor src: string | undefined = undefined;

  @property({ type: String })
  accessor name: string | undefined = undefined;

  @property({ type: String })
  accessor alt: string | undefined = undefined;

  @property({ type: String, reflect: true })
  accessor size: AvatarSize = "md";

  @property({ type: String, reflect: true })
  accessor shape: AvatarShape = "circle";

  @state()
  private accessor _imgError = false;

  protected override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    // A new src gets a fresh chance to load before we fall back to initials.
    if (changed.has("src")) this._imgError = false;
    if (changed.has("size")) this.size = oneOf(this.size, avatarSizes, "md");
    if (changed.has("shape")) {
      this.shape = oneOf(this.shape, avatarShapes, "circle");
    }
  }

  override render() {
    const src = (this.src ?? "").trim();
    const name = this.name;
    const showImage = src.length > 0 && isAvatarImageUrl(src) &&
      !this._imgError;
    const showGlyph = src.length > 0 && !isAvatarImageUrl(src);

    return html`
      <span
        class="avatar"
        part="avatar"
        role="img"
        aria-label="${this.alt ?? name ?? "avatar"}"
      >
        ${showImage
          ? html`
            <img
              src="${src}"
              alt="${this.alt ?? name ?? ""}"
              @error="${this._onImgError}"
            />
          `
          : showGlyph
          ? html`
            <span class="glyph" part="glyph">${src}</span>
          `
          : html`
            <span class="initials" part="initials">
              ${initialsForName(name)}
            </span>
          `}
      </span>
    `;
  }

  private _onImgError = (): void => {
    this._imgError = true;
  };
}

if (!globalThis.customElements.get("cf-avatar")) {
  globalThis.customElements.define("cf-avatar", CFAvatar);
}

declare global {
  interface HTMLElementTagNameMap {
    "cf-avatar": CFAvatar;
  }
}
