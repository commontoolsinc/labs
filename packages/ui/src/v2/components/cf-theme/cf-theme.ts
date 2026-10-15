import { type CellHandle, isCellHandle } from "@commonfabric/runtime-client";
import { ContextConsumer, provide } from "@lit/context";
import { css, html } from "lit";
import { property } from "lit/decorators.js";

import { BaseElement } from "../../core/base-element.ts";
import { valueForDisplay } from "../../core/value-for-display.ts";
import {
  applyThemeToElement,
  type CFTheme,
  cfThemeContext,
  defaultTheme,
  mergeWithDefaultTheme,
} from "../theme-context.ts";

export function unwrapThemeCellValues(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (isCellHandle(value)) {
    // A theme value the worker will not show, or has not answered, reads as
    // `undefined`, which the object branch below leaves out, so the default
    // takes its place.
    return valueForDisplay(value);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return value;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => unwrapThemeCellValues(item, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const unwrapped = unwrapThemeCellValues(child, seen);
    // Left out rather than set to `undefined`, which a merge would take
    // over the default.
    if (unwrapped !== undefined) out[key] = unwrapped;
  }
  return out;
}

export function subscribeToThemeCellValues(
  value: unknown,
  onChange: () => void,
  seen = new WeakSet<object>(),
): Array<() => void> {
  const unsubs: Array<() => void> = [];

  const visit = (current: unknown) => {
    if (isCellHandle(current)) {
      const cellVal = current as CellHandle<unknown>;
      let didReceiveInitialValue = false;
      const changed = () => {
        if (!didReceiveInitialValue) {
          didReceiveInitialValue = true;
          return;
        }
        onChange();
      };
      const off = cellVal.subscribe(changed, { onRefused: changed });
      unsubs.push(off);
      return;
    }

    if (!current || typeof current !== "object") {
      return;
    }

    if (seen.has(current)) {
      return;
    }
    seen.add(current);

    for (const child of Object.values(current)) {
      visit(child);
    }
  };

  visit(value);
  return unsubs;
}

/**
 * cf-theme — Provides a theme to a subtree and applies CSS vars.
 *
 * Usage:
 * <cf-theme .theme=${partialTheme}><slot/></cf-theme>
 *
 * The component unwraps CellHandle values inside a partial theme, merges the
 * result over the enclosing `cf-theme`'s theme, or over the defaults when there
 * is none, provides it via context, and sets CSS custom properties on the host
 * so descendants pick up tokens. A nested instance sets only the properties
 * its partial changes, and the rest inherit from the enclosing one; an
 * outermost instance sets them all.
 *
 * @element cf-theme
 */
export class CFThemeProvider extends BaseElement {
  static override styles = css`
    :host {
      display: contents; /* do not add extra layout */
    }
  `;

  /** Partial or full theme object (pattern-style supported) */
  @property({ attribute: false })
  accessor theme: any = {};

  /** Computed full theme that is provided to children */
  @provide({ context: cfThemeContext })
  @property({ attribute: false })
  accessor _computedTheme: CFTheme = defaultTheme;

  #unsubs: Array<() => void> = [];

  /** The enclosing `cf-theme`'s theme, or `undefined` for an outermost one. */
  #enclosing: CFTheme | undefined;

  private _mediaQuery?: MediaQueryList;
  private _onMediaChange = () => this._recomputeAndApply();
  private _onThemePreferenceChanged = () => this._recomputeAndApply();

  constructor() {
    super();
    // A provider ignores requests from its own host, so this one is answered
    // by the enclosing `cf-theme`, if there is one.
    new ContextConsumer(this, {
      context: cfThemeContext,
      subscribe: true,
      callback: (theme) => {
        this.#enclosing = theme;
        if (this.hasUpdated) this._recomputeAndApply();
      },
    });
  }

  override connectedCallback(): void {
    // Reconnected elsewhere, it is outermost unless a provider answers again.
    this.#enclosing = undefined;
    super.connectedCallback();
    if (this.hasUpdated) this._recomputeAndApply();
    // Re-resolve when user toggles theme preference (data-theme attribute)
    document.addEventListener(
      "theme-preference-changed",
      this._onThemePreferenceChanged,
    );
  }

  override firstUpdated(changed: Map<string | number | symbol, unknown>) {
    super.firstUpdated(changed);
    this._recomputeAndApply();
  }

  override updated(changed: Map<string | number | symbol, unknown>) {
    super.updated(changed);
    if (changed.has("theme")) {
      this._recomputeAndApply();
    }
  }

  private _recomputeAndApply() {
    this._computedTheme = mergeWithDefaultTheme(
      unwrapThemeCellValues(this.theme),
      this.#enclosing,
    );
    applyThemeToElement(this, this._computedTheme, this.#enclosing);
    this.#setupSubscriptions();

    // Manage the matchMedia listener based on the resolved colorScheme
    if (this._computedTheme.colorScheme === "auto") {
      if (
        !this._mediaQuery && typeof globalThis !== "undefined" &&
        globalThis.matchMedia
      ) {
        this._mediaQuery = globalThis.matchMedia(
          "(prefers-color-scheme: dark)",
        );
        this._mediaQuery.addEventListener("change", this._onMediaChange);
      }
    } else {
      if (this._mediaQuery) {
        this._mediaQuery.removeEventListener("change", this._onMediaChange);
        this._mediaQuery = undefined;
      }
    }
  }

  #setupSubscriptions() {
    // Clear previous subscriptions
    for (const off of this.#unsubs) off();
    this.#unsubs = [];

    this.#unsubs = subscribeToThemeCellValues(
      this.theme,
      () => this._recomputeAndApply(),
    );
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    for (const off of this.#unsubs) off();
    this.#unsubs = [];
    if (this._mediaQuery) {
      this._mediaQuery.removeEventListener("change", this._onMediaChange);
      this._mediaQuery = undefined;
    }
    document.removeEventListener(
      "theme-preference-changed",
      this._onThemePreferenceChanged,
    );
  }

  override render() {
    return html`
      <slot></slot>
    `;
  }
}
