import { css, html, type PropertyValues } from "lit";
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
import { runtimeContext, spaceContext } from "../../runtime-context.ts";

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
 * main thread (outside the iframe sandbox where patterns run), which makes it the
 * right home for an *unspoofable* identity treatment — but that property is
 * **deferred, not delivered by v1**: today the seal renders unconditionally and
 * `_state` is always "presented", so a pattern could compose a visually identical
 * badge. v1 just renders avatar + name from the cell.
 *
 * The deferred pass (see CT-1645 follow-ups) is what earns "unspoofable": read
 * the cell's CFC label via `getCfcLabel()` (the `represents-principal` atom →
 * owner DID), compare it to the authenticated identity, and draw the "seal"
 * effects **only when verified** (gate on `_state === "verified"`). The seam is
 * `_refreshVerification()` + the `_state` field; reuse `authorshipStateForLabel`
 * from `cf-cfc-authorship`.
 *
 * @element cf-profile-badge
 * @attr {string} size - avatar size: xs | sm | md | lg | xl (default md)
 */
export class CFProfileBadge extends BaseElement {
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

      /* Reserved for the deferred trusted pass: when verification lands, a
        "verified" badge gets the system seal treatment that user-space CSS
        cannot reproduce (it depends on runtime-confirmed provenance, not just
        these styles). */
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

  private _unsubscribe?: () => void;
  private _resolveGeneration = 0;

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
  }

  protected override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    if (changed.has("profile")) {
      void this._resolve();
    }
  }

  private _cleanup(): void {
    this._unsubscribe?.();
    this._unsubscribe = undefined;
  }

  private async _resolve(): Promise<void> {
    const generation = ++this._resolveGeneration;
    this._cleanup();

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
      this._applyValue(undefined);
    }
  }

  private _applyValue(val: unknown): void {
    const { name, avatar } = profileDisplayFromValue(val);
    this._name = name;
    this._avatar = avatar;
    this.requestUpdate();
  }

  /**
   * Trust seam — deferred. The unspoofable presentation will read the resolved
   * cell's CFC label (`represents-principal` → owner DID, via `getCfcLabel()`),
   * verify it against the authenticated identity, set `_state` accordingly, and
   * only then draw the seal/effects that user-space cannot reproduce. v1
   * intentionally renders the unverified "presented" state. Reuse
   * `authorshipStateForLabel` / the label helpers from cf-cfc-authorship.
   *
   * LIFECYCLE: this is synchronous today, so it is safe. When the deferred pass
   * introduces an `await` (label read), it MUST re-check
   * `generation === this._resolveGeneration && this.isConnected` AFTER the await
   * before writing `_state`, otherwise it leaks state writes onto detached /
   * superseded instances (same hazard guarded against in `_resolve`).
   */
  private _refreshVerification(_cell: CellHandle): void {
    this._state = "presented";
  }

  override render() {
    return html`
      <span
        class="badge"
        part="root"
        data-cf-profile-badge
        data-state="${this._state}"
      >
        <cf-avatar
          part="avatar"
          exportparts="avatar"
          .src="${this._avatar}"
          .name="${this._name}"
          size="${this.size}"
        ></cf-avatar>
        <span class="name" part="name">
          ${this._name ?? "Unknown profile"}
        </span>
        <span
          class="seal"
          part="seal"
          aria-hidden="true"
          title="System-rendered identity"
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
