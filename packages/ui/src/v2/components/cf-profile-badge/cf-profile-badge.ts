import { css, html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { consume } from "@lit/context";
import { BaseElement } from "../../core/base-element.ts";
import "../cf-avatar/cf-avatar.ts";
import type { AvatarSize } from "../cf-avatar/cf-avatar.ts";
import {
  type CellHandle,
  NAME,
  type RuntimeClient,
} from "@commonfabric/runtime-client";
import type { DID } from "@commonfabric/identity";
import {
  appViewToUrlPath,
  navigate,
  preserveAppViewMode,
  urlToAppView,
} from "@commonfabric/shell/shared";
import { runtimeContext, spaceContext } from "../../runtime-context.ts";
import {
  ownerPrincipalFromLabel,
  readCfcLabelView,
} from "../../core/cfc-label.ts";
import { type IdentitySeal, identitySeal } from "./identity-seal.ts";
import {
  registerSeal,
  type SealLivenessClient,
  unregisterSeal,
} from "./seal-liveness.ts";

/** Verification state of the presented identity. */
export type ProfileBadgeState = "presented" | "verified" | "unverified";

export type ProfileBadgeDisplay = {
  name: string | undefined;
  avatar: string | undefined;
};

/**
 * Extracts the display name + avatar from a subscribed profile-cell value.
 * Prefers the profile's own editable `name` field, falling back to the cell's
 * `[NAME]`. This ordering matters: on `main`, profile-home sets `[NAME]` to the
 * static placeholder `"Profile"` (profile-home.tsx:303), so trusting `[NAME]`
 * first would render every profile as "Profile". The `name` field is the
 * reliable display name; on the multi-profile branch `[NAME]` becomes the
 * person's name and either source yields the same result. Pure, so it is
 * unit-testable without a runtime.
 */
export const profileDisplayFromValue = (val: unknown): ProfileBadgeDisplay => {
  if (!val || typeof val !== "object") {
    return { name: undefined, avatar: undefined };
  }
  const record = val as Record<PropertyKey, unknown>;
  const named = record[NAME as unknown as PropertyKey];
  const plain = record["name"];
  const avatar = record["avatar"];
  const name = typeof plain === "string" && plain.trim().length > 0
    ? plain
    : typeof named === "string" && named.trim().length > 0
    ? named
    : undefined;
  return {
    name,
    avatar: typeof avatar === "string" && avatar.trim().length > 0
      ? avatar
      : undefined,
  };
};

/**
 * CFProfileBadge — official presentation of a profile (avatar + name).
 *
 * You bind it a *cell* containing a profile (e.g. `$profile={profileCell}`) and
 * it renders the person's avatar + name as system chrome. It runs on the trusted
 * main thread (outside the iframe sandbox where patterns run), which is what lets
 * it draw an identity treatment a pattern cannot forge.
 *
 * When the bound cell carries a runtime-attested `represents-principal` CFC label
 * (read over trusted IPC via `getCfcLabel()`), the badge enters the **verified**
 * state and draws a *generative identity seal* — a deterministic aura derived
 * purely from the owner's principal DID (see `identity-seal.ts`). Because the
 * aura is a pure function of the DID, it is the *same everywhere* that person's
 * badge appears, so it reads as a recognizable fingerprint of their identity;
 * and because it is gated on the attestation (which user-space cannot mint), a
 * pattern can mimic the CSS but not earn the verified seal for a DID it doesn't
 * control. Without that label the badge stays in the plain "presented" state.
 *
 * @element cf-profile-badge
 * @attr {string} size - avatar size: xs | sm | md | lg | xl (default md)
 */
export class CFProfileBadge extends BaseElement implements SealLivenessClient {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: inline-block;
        vertical-align: middle;
        max-width: 100%;
      }

      .badge {
        box-sizing: border-box;
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        max-width: 100%;
        padding: 0.1875rem 0.625rem 0.1875rem 0.1875rem;
        border-radius: var(--cf-border-radius-full, 9999px);
        border: 1px solid var(--cf-theme-color-border, hsl(0, 0%, 89%));
        background: var(--cf-theme-color-surface, hsl(0, 0%, 99%));
        color: var(--cf-theme-color-text, hsl(0, 0%, 9%));
        line-height: 1;
      }

      /* CT-1750: navigable badges (bound to a real profile cell) act as links. */
      .badge[data-navigable] {
        cursor: pointer;
      }

      .badge[data-navigable]:focus-visible {
        outline: 2px solid var(--cf-theme-color-primary, hsl(212, 100%, 47%));
        outline-offset: 2px;
      }

      .name {
        font-size: var(--cf-font-size-sm, 0.8125rem);
        font-weight: var(--cf-font-weight-semibold, 600);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 16ch;
      }

      .seal {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: var(--cf-theme-color-muted-foreground, hsl(0, 0%, 55%));
        flex: 0 0 auto;
      }

      .seal svg {
        width: 0.875rem;
        height: 0.875rem;
        display: block;
      }

      /* The generative aura ring. Transparent until the badge is verified; when
        verified, a separate aura-ring layer carries the per-identity conic
        gradient (a pure function of the owner DID) behind the avatar, so the ring
        is unique-but-stable for each person. Keeping it on its own layer lets it
        rotate in lockstep (the always-on animation below) and carry the shimmer
        and cursor-sheen layers, all without rotating the avatar. */
      .aura {
        position: relative;
        display: inline-flex;
        flex: 0 0 auto;
        border-radius: var(--cf-border-radius-full, 9999px);
        padding: 0;
      }

      .aura-ring {
        position: absolute;
        inset: 0;
        border-radius: var(--cf-border-radius-full, 9999px);
        z-index: 0;
        transform-origin: center;
      }

      /* Intrinsic shimmer — a soft light band that sweeps across the disc on a
        shared clock (seeded per-badge via animation-delay so every verified seal
        sweeps in lockstep). Keeps the seal visibly "alive" even when the cursor
        is still, in a way ordinary chrome never is. Sits above the avatar so the
        light glazes the face; screen-blended and contained by the aura's
        isolation so it only lifts the badge, not the page behind it. */
      .aura-glow {
        position: absolute;
        inset: 0;
        border-radius: var(--cf-border-radius-full, 9999px);
        z-index: 2;
        pointer-events: none;
        opacity: 0;
        mix-blend-mode: screen;
        background: linear-gradient(
          115deg,
          transparent 34%,
          hsl(var(--seal-hue, 200) 95% 90% / 0.5) 47%,
          rgba(255, 255, 255, 0.85) 50%,
          hsl(var(--seal-hue, 200) 95% 90% / 0.5) 53%,
          transparent 66%
        );
        background-size: 280% 280%;
      }

      /* Cursor sheen — a bright reflective hotspot that tracks the host cursor,
        even when the cursor is nowhere near the badge. Driven by
        --seal-mx/--seal-my/--seal-sheen-a/--seal-sheen-hue, which the shared
        liveness controller sets on the host (they inherit into this layer). A
        sandboxed pattern only sees pointer events inside its own iframe, so a
        forgery cannot reproduce this. */
      .aura-sheen {
        position: absolute;
        inset: 0;
        border-radius: var(--cf-border-radius-full, 9999px);
        z-index: 3;
        pointer-events: none;
        opacity: var(--seal-sheen-a, 0);
        mix-blend-mode: screen;
        background:
          radial-gradient(
            circle at var(--seal-mx, 50%) var(--seal-my, 50%),
            rgba(255, 255, 255, 1) 0%,
            rgba(255, 255, 255, 0.6) 11%,
            rgba(255, 255, 255, 0) 32%
          ),
          radial-gradient(
          circle at var(--seal-mx, 50%) var(--seal-my, 50%),
          hsl(var(--seal-sheen-hue, 200) 100% 72% / 0.9) 0%,
          hsl(var(--seal-sheen-hue, 200) 100% 60% / 0) 52%
        );
      }

      .aura cf-avatar {
        position: relative;
        z-index: 1;
      }

      .badge[data-state="verified"] .aura {
        padding: 3px;
        isolation: isolate;
        transition: transform 200ms ease-out;
      }

      .badge[data-state="verified"] .aura cf-avatar {
        box-shadow: 0 0 0 2px var(--cf-theme-color-surface, hsl(0, 0%, 99%));
        border-radius: var(--cf-border-radius-full, 9999px);
      }

      /* Ambient self-motion is gated to :hover so a dense roster stays calm at
        rest and a seal comes alive when engaged. The cursor sheen (.aura-sheen,
        above) is the *always-on* part — it reacts to the host cursor anywhere on
        screen, hovered or not, which is the unforgeable signal. On hover the ring
        rotates, the shimmer sweeps, and the seal lifts a touch. */
      .badge[data-state="verified"] .aura:hover .aura-ring {
        animation: cf-aura-spin 26s linear infinite;
      }

      .badge[data-state="verified"] .aura:hover .aura-glow {
        opacity: 1;
        animation: cf-aura-glow 7s linear infinite;
      }

      .badge[data-state="verified"] .aura:hover {
        transform: scale(1.04);
        transition: transform 160ms ease-out;
      }

      @keyframes cf-aura-spin {
        to {
          transform: rotate(1turn);
        }
      }

      @keyframes cf-aura-glow {
        0% {
          background-position: 0% 0%;
        }
        100% {
          background-position: 280% 280%;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .badge[data-state="verified"] .aura:hover .aura-ring,
        .badge[data-state="verified"] .aura:hover .aura-glow {
          animation: none;
        }
        .badge[data-state="verified"] .aura:hover .aura-glow {
          opacity: 0;
        }
        .badge[data-state="verified"] .aura:hover {
          transform: none;
        }
      }

      /* When verified the seal mark is tinted with the identity's accent color
        (also DID-derived), supplied inline. */
      .badge[data-state="verified"] .seal {
        color: var(--cf-theme-color-primary, hsl(212, 100%, 47%));
      }
    `,
  ];

  /** The profile cell to present. Bound from a pattern via `$profile={cell}`. */
  @property({ attribute: false })
  accessor profile: CellHandle | undefined = undefined;

  @property({ type: String, reflect: true })
  accessor size: AvatarSize = "md";

  @consume({ context: runtimeContext, subscribe: true })
  @property({ attribute: false })
  accessor runtime: RuntimeClient | undefined = undefined;

  @consume({ context: spaceContext, subscribe: true })
  @property({ attribute: false })
  accessor space: DID | undefined = undefined;

  @state()
  private accessor _name: string | undefined = undefined;

  @state()
  private accessor _avatar: string | undefined = undefined;

  @state()
  private accessor _state: ProfileBadgeState = "presented";

  /** Generative identity seal, derived from the owner DID once verified. */
  @state()
  private accessor _seal: IdentitySeal | undefined = undefined;

  // CT-1750: navigation. `_resolvedCell` is the resolved profile cell;
  // `_navigable` is true only when it's a root cell (a real profile piece). A
  // badge bound to a real profile (rosters/lists) navigates to that profile's
  // page on click; one bound to a derived/sub-path cell (e.g. a self-view
  // `{name, avatar}` cell on the profile page itself) is non-navigable and the
  // click is a no-op.
  private _resolvedCell: CellHandle | undefined = undefined;
  @state()
  private accessor _navigable = false;

  private _unsubscribe?: () => void;
  private _resolveGeneration = 0;

  // Liveness: whether this seal is currently registered with the shared cursor
  // controller, and the last sheen alpha written (so far-from-cursor frames can
  // skip redundant style writes).
  private _livenessRegistered = false;
  private _lastSheenA = -1;

  override connectedCallback(): void {
    super.connectedCallback();
    void this._resolve();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    // Bump the generation so any in-flight `_resolve` continuation fails its
    // `generation !== this._resolveGeneration` guard and bails before
    // subscribing / writing state on this now-detached instance. Without this,
    // an element that disconnects DURING the `await cell.resolveAsCell()` would
    // resume, pass the (unchanged) generation check, and leak a live
    // subscription that updates a detached element.
    this._resolveGeneration++;
    this._cleanup();
    this._setLiveness(false);
  }

  protected override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    if (changed.has("profile")) {
      void this._resolve();
    }
  }

  protected override updated(changed: PropertyValues): void {
    super.updated(changed);
    // Register for cursor sheen only while actually verified + connected. The
    // shared controller manages reduced-motion (it won't run the loop while the
    // user prefers reduced motion, and tears it down live if they enable it).
    const verified = this._state === "verified" && this._seal !== undefined;
    this._setLiveness(verified && this.isConnected);
  }

  private _setLiveness(on: boolean): void {
    if (on === this._livenessRegistered) return;
    this._livenessRegistered = on;
    if (on) {
      registerSeal(this);
    } else {
      unregisterSeal(this);
      this._lastSheenA = -1;
    }
  }

  /**
   * Called once per animation frame by the shared liveness controller while
   * this seal is registered. Places a reflective hotspot on the seal in the
   * direction of the host cursor, brightening as the cursor nears — and
   * responding even when the cursor is far away (the unforgeable part). Reads
   * the aura's own rect so geometry is correct regardless of the badge's
   * surrounding layout, and culls when offscreen.
   */
  updateSeal(cursorX: number, cursorY: number, frameMs: number): void {
    const aura = this.shadowRoot?.querySelector(".aura") as HTMLElement | null;
    if (!aura) return;
    const r = aura.getBoundingClientRect();
    const vh = globalThis.innerHeight ?? 0;
    if (r.width === 0 || r.bottom < -80 || r.top > vh + 80) {
      if (this._lastSheenA !== 0) {
        this.style.setProperty("--seal-sheen-a", "0");
        this._lastSheenA = 0;
      }
      return;
    }
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = cursorX - cx;
    const dy = cursorY - cy;
    const dist = Math.hypot(dx, dy);
    const prox = Math.max(0, 1 - dist / 520); // 1 at center → 0 by ~520px
    const a = Math.min(1, prox * prox * 1.25 + prox * 0.15); // punchy near
    // Far + already dark: nothing to draw, skip all writes (cheap at scale).
    if (a === 0 && this._lastSheenA === 0) return;
    this._lastSheenA = a;
    const reach = Math.max(r.width, r.height) * 1.9;
    const nx = Math.max(-1, Math.min(1, dx / reach));
    const ny = Math.max(-1, Math.min(1, dy / reach));
    const hue = this._seal?.hue ?? 0;
    this.style.setProperty("--seal-mx", `${(50 + nx * 62).toFixed(1)}%`);
    this.style.setProperty("--seal-my", `${(50 + ny * 62).toFixed(1)}%`);
    this.style.setProperty("--seal-sheen-a", a.toFixed(3));
    this.style.setProperty(
      "--seal-sheen-hue",
      String(Math.round((hue + frameMs * 0.03 + nx * 40 + 360) % 360)),
    );
  }

  /**
   * Reset the cursor sheen to nothing. Called by the shared controller when it
   * stops the loop (e.g. the user enables reduced motion) so the highlight
   * doesn't freeze mid-glint.
   */
  clearSeal(): void {
    this.style.setProperty("--seal-sheen-a", "0");
    this._lastSheenA = 0;
  }

  private _cleanup(): void {
    this._unsubscribe?.();
    this._unsubscribe = undefined;
  }

  private async _resolve(): Promise<void> {
    const generation = ++this._resolveGeneration;
    this._cleanup();
    // Clear any prior verification up-front: a re-bind to a different profile
    // must not keep showing the previous profile's seal during the async
    // re-resolve + attestation gap. `_refreshVerification` re-derives it below.
    this._state = "presented";
    this._seal = undefined;
    // Drop navigation state until the (new) cell resolves — a stale link must
    // not survive a re-bind.
    this._resolvedCell = undefined;
    this._navigable = false;

    const cell = this.profile;
    if (!cell) {
      this._applyValue(undefined);
      return;
    }

    try {
      const resolved = await cell.resolveAsCell();
      // Bail if a newer resolve superseded us OR if we were disconnected during
      // the await (disconnectedCallback bumps the generation, so the first guard
      // already covers detachment; isConnected is kept as a belt-and-braces
      // check so we never subscribe / write state on a detached instance).
      if (generation !== this._resolveGeneration || !this.isConnected) return;

      // CT-1750: remember the resolved cell and whether it's a navigable root
      // piece (only root cells map to a profile page; sub-path/derived cells
      // don't).
      this._resolvedCell = resolved;
      this._navigable = resolved.ref().path.length === 0;

      // Subscribe with a minimal schema so the runtime only resolves the fields
      // we render, rather than walking the whole profile output graph (mirrors
      // cf-cell-link's $NAME-only subscription).
      const named = resolved.asSchema<
        { [NAME]?: string; name?: string; avatar?: string }
      >({
        type: "object",
        properties: {
          [NAME]: { type: "string" },
          name: { type: "string" },
          avatar: { type: "string" },
        },
      });
      this._unsubscribe = named.subscribe((val) => this._applyValue(val));

      void this._refreshVerification(resolved);
    } catch (e) {
      if (generation !== this._resolveGeneration || !this.isConnected) return;
      console.error("cf-profile-badge: failed to resolve profile cell", e);
      this._resolvedCell = undefined;
      this._navigable = false;
      this._applyValue(undefined);
    }
  }

  /**
   * Navigate to the bound profile's page (CT-1750). No-op unless the resolved
   * cell is a navigable root piece. Mirrors cf-cell-link's navigation; Cmd/Ctrl
   * opens in a new tab.
   */
  private _navigateToProfile(openInNewTab: boolean): void {
    const cell = this._resolvedCell;
    if (!cell || cell.ref().path.length > 0) return;
    const view = { spaceDid: cell.space(), pieceId: cell.id() };
    if (openInNewTab) {
      const url = appViewToUrlPath(
        preserveAppViewMode(
          urlToAppView(new URL(globalThis.location.href)),
          view,
        ),
      );
      globalThis.open(url, "_blank");
    } else {
      navigate(view);
    }
  }

  private _handleClick(e: MouseEvent): void {
    if (!this._navigable) return;
    e.stopPropagation();
    this._navigateToProfile(e.metaKey || e.ctrlKey);
  }

  private _handleKeydown(e: KeyboardEvent): void {
    if (!this._navigable) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      this._navigateToProfile(e.metaKey || e.ctrlKey);
    }
  }

  private _applyValue(val: unknown): void {
    const { name, avatar } = profileDisplayFromValue(val);
    this._name = name;
    this._avatar = avatar;
    this.requestUpdate();
  }

  /**
   * Reads the resolved cell's runtime-attested CFC label and, if it carries a
   * `represents-principal` atom, enters the verified state and derives the
   * generative seal from the owner principal DID. The seal is a pure function of
   * the DID, so it is identical wherever this person's badge renders. No
   * attestation → the badge stays in the plain "presented" state (a pattern can
   * mimic the chrome but cannot mint the label that unlocks the seal).
   *
   * LIFECYCLE: this awaits a label read, so after the await it MUST re-check
   * `generation === this._resolveGeneration && this.isConnected` before writing
   * `_state`/`_seal` — `disconnectedCallback` bumps the generation, so a badge
   * detached (or re-bound) mid-read won't leak a state write onto a stale /
   * detached instance (same hazard guarded in `_resolve`).
   */
  private async _refreshVerification(cell: CellHandle): Promise<void> {
    const generation = this._resolveGeneration;
    try {
      const view = await readCfcLabelView(cell);
      if (generation !== this._resolveGeneration || !this.isConnected) return;
      const owner = ownerPrincipalFromLabel(view);
      if (owner) {
        this._seal = identitySeal(owner);
        this._state = "verified";
      } else {
        this._seal = undefined;
        this._state = "presented";
      }
    } catch (e) {
      if (generation !== this._resolveGeneration || !this.isConnected) return;
      // Surface the IPC/label-read failure (mirrors `_resolve`'s catch) rather
      // than silently collapsing every failure to the unverified state.
      console.error(
        "cf-profile-badge: failed to read CFC label for verification",
        e,
      );
      this._seal = undefined;
      this._state = "presented";
    }
  }

  override render() {
    const verified = this._state === "verified" && this._seal !== undefined;
    // The aura ring layer carries the DID-derived conic gradient plus a soft glow
    // in the identity's hue, so the fingerprint reads at badge scale.
    const hue = this._seal?.hue ?? 0;
    const ringStyle = verified
      ? `background: ${
        this._seal!.ringGradient
      }; box-shadow: 0 0 0 1px hsl(${hue} 80% 58% / 0.3), 0 0 10px -1px hsl(${hue} 85% 60% / 0.7);`
      : "";
    const sealStyle = verified ? `color: ${this._seal!.accent};` : "";
    const sealTitle = verified
      ? "Identity verified by the system"
      : "System-rendered identity";
    // Per-identity hue, supplied inline so the hover shimmer is tinted to match
    // this identity's palette.
    const auraStyle = verified ? `--seal-hue: ${hue};` : "";

    return html`
      <span
        class="badge"
        part="root"
        data-cf-profile-badge
        data-state="${this._state}"
        ?data-navigable="${this._navigable}"
        role="${this._navigable ? "link" : nothing}"
        tabindex="${this._navigable ? "0" : nothing}"
        @click="${this._handleClick}"
        @keydown="${this._handleKeydown}"
      >
        <span class="aura" part="aura" style="${auraStyle}">
          ${verified
            ? html`
              <span class="aura-ring" part="aura-ring" style="${ringStyle}"> </span>
            `
            : null}
          <cf-avatar
            part="avatar"
            exportparts="avatar"
            .src="${this._avatar}"
            .name="${this._name}"
            size="${this.size}"
          ></cf-avatar>
          ${verified
            ? html`
              <span class="aura-glow" part="aura-glow" aria-hidden="true"></span>
              <span class="aura-sheen" part="aura-sheen" aria-hidden="true"></span>
            `
            : null}
        </span>
        <span class="name" part="name">
          ${this._name ?? "Unknown profile"}
        </span>
        <span
          class="seal"
          part="seal"
          aria-hidden="true"
          title="${sealTitle}"
          style="${sealStyle}"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            ${verified
              ? html`
                <path d="M9 12l2 2 4-4" />
              `
              : null}
          </svg>
        </span>
      </span>
    `;
  }
}

if (!globalThis.customElements.get("cf-profile-badge")) {
  globalThis.customElements.define("cf-profile-badge", CFProfileBadge);
}

declare global {
  interface HTMLElementTagNameMap {
    "cf-profile-badge": CFProfileBadge;
  }
}
