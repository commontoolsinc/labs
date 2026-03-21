/**
 * @fileoverview UI Loader Component - Spinning loading indicator
 *
 * @module ct-loader
 * @description
 * A simple inline spinner for visualizing pending async operations.
 * Optionally displays elapsed time and a stop/cancel button.
 *
 * @example
 * ```html
 * <!-- Basic spinner -->
 * <ct-loader></ct-loader>
 *
 * <!-- With elapsed time -->
 * <ct-loader showElapsed></ct-loader>
 *
 * <!-- With stop button -->
 * <ct-loader showElapsed showStop @ct-stop=${handleCancel}></ct-loader>
 *
 * <!-- Small inline spinner -->
 * <span>Loading <ct-loader size="sm"></ct-loader></span>
 * ```
 */

import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";

export type LoaderSize = "sm" | "md" | "lg";

/**
 * CTLoader displays a spinning loading indicator.
 *
 * @tag ct-loader
 * @extends BaseElement
 *
 * @property {LoaderSize} size - Size variant: "sm" (12px), "md" (24px), "lg" (48px)
 * @property {boolean} showElapsed - Whether to display elapsed time
 * @property {boolean} showStop - Whether to display stop button
 *
 * @fires ct-stop - Fired when stop button is clicked
 *
 * @csspart spinner - The spinning circle SVG
 * @csspart elapsed - The elapsed time text
 * @csspart stop - The stop button
 */
export class CTLoader extends BaseElement {
  static override styles = css`
    :host {
      --ct-loader-color-track: var(
        --ct-theme-color-border,
        #d4d2c8
      );
      --ct-loader-color-arc: var(
        --ct-theme-color-primary,
        #2d8c3c
      );
      --ct-loader-color-text: var(
        --ct-theme-color-text-muted,
        #7a7d72
      );
      --ct-loader-color-surface: var(
        --ct-theme-color-surface,
        #f3f1eb
      );
      --ct-loader-color-error: var(
        --ct-theme-color-error,
        #c44536
      );

      display: inline-flex;
      align-items: center;
      vertical-align: middle;
      gap: 0.5rem;
    }

    *,
    *::before,
    *::after {
      box-sizing: border-box;
    }

    .spinner {
      animation: spin 0.9s cubic-bezier(0.4, 0.15, 0.6, 0.85) infinite;
    }

    /* Size variants: sm=14px, md=24px, lg=48px */
    :host([size="sm"]) .spinner {
      width: 14px;
      height: 14px;
    }

    :host([size="md"]) .spinner,
    :host(:not([size])) .spinner {
      width: 24px;
      height: 24px;
    }

    :host([size="lg"]) .spinner {
      width: 48px;
      height: 48px;
    }

    .track {
      stroke: var(--ct-loader-color-track, #d4d2c8);
      opacity: 0.4;
    }

    .arc {
      stroke: var(--ct-loader-color-arc, #2d8c3c);
      stroke-linecap: round;
    }

    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }

    .elapsed {
      font-size: 0.8125rem;
      font-weight: 700;
      color: var(--ct-loader-color-text, #7a7d72);
      font-variant-numeric: tabular-nums;
      font-family: var(--ct-theme-font-family, inherit);
      -webkit-font-smoothing: antialiased;
    }

    .stop-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      padding: 0;
      border: none;
      border-radius: 50%;
      background: transparent;
      color: var(--ct-loader-color-text, #7a7d72);
      cursor: pointer;
      transition: all 150ms ease;
    }

    .stop-button:hover {
      background: var(--ct-loader-color-surface, #f3f1eb);
      color: var(--ct-loader-color-error, #c44536);
    }

    .stop-button:active {
      transform: scale(0.9);
      transition-duration: 0.08s;
    }

    .stop-button svg {
      width: 10px;
      height: 10px;
    }

    /* Screen reader only */
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border-width: 0;
    }

    @media (prefers-reduced-motion: reduce) {
      .spinner {
        animation: none;
      }
    }
  `;

  static override properties = {
    size: { type: String, reflect: true },
    showElapsed: { type: Boolean, attribute: "show-elapsed" },
    showStop: { type: Boolean, attribute: "show-stop" },
  };

  declare size: LoaderSize;
  declare showElapsed: boolean;
  declare showStop: boolean;

  private _startTime: number = 0;
  private _elapsedMs: number = 0;
  private _animationFrame: number | null = null;

  constructor() {
    super();
    this.size = "md";
    this.showElapsed = false;
    this.showStop = false;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this._startTime = Date.now();
    if (this.showElapsed) {
      this._startTimer();
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._stopTimer();
  }

  override updated(changedProperties: Map<string, unknown>): void {
    if (changedProperties.has("showElapsed")) {
      if (this.showElapsed) {
        this._startTimer();
      } else {
        this._stopTimer();
      }
    }
  }

  private _startTimer(): void {
    if (this._animationFrame !== null) return;

    const tick = () => {
      this._elapsedMs = Date.now() - this._startTime;
      this.requestUpdate();
      this._animationFrame = requestAnimationFrame(tick);
    };
    this._animationFrame = requestAnimationFrame(tick);
  }

  private _stopTimer(): void {
    if (this._animationFrame !== null) {
      cancelAnimationFrame(this._animationFrame);
      this._animationFrame = null;
    }
  }

  private _formatElapsed(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) {
      return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  }

  private _handleStop(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.emit("ct-stop", {});
  }

  override render() {
    return html`
      <svg
        class="spinner"
        part="spinner"
        viewBox="0 0 24 24"
        role="status"
        aria-label="Loading"
      >
        <circle
          class="track"
          cx="12"
          cy="12"
          r="10"
          fill="none"
          stroke-width="2"
        />
        <circle
          class="arc"
          cx="12"
          cy="12"
          r="10"
          fill="none"
          stroke-width="2"
          stroke-dasharray="15 47"
        />
      </svg>

      ${this.showElapsed
        ? html`
          <span class="elapsed" part="elapsed">${this._formatElapsed(
            this._elapsedMs,
          )}</span>
        `
        : null} ${this.showStop
        ? html`
          <button
            class="stop-button"
            part="stop"
            type="button"
            @click="${this._handleStop}"
            aria-label="Stop"
            title="Stop"
          >
            <svg viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="1" />
            </svg>
          </button>
        `
        : null}

      <span class="sr-only">Loading</span>
    `;
  }

  /** Reset the elapsed timer */
  resetTimer(): void {
    this._startTime = Date.now();
    this._elapsedMs = 0;
  }
}

globalThis.customElements.define("ct-loader", CTLoader);
