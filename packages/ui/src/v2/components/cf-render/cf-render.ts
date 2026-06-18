import { css, html, PropertyValues } from "lit";
import { createRef, type Ref, ref } from "lit/directives/ref.js";
import { state } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";
import { render } from "@commonfabric/html/client";
import type { CellHandle } from "@commonfabric/runtime-client";
import { CHIP_UI, TILE_UI, type VNode } from "@commonfabric/runtime-client";
import {
  appViewToUrlPath,
  navigate,
  preserveAppViewMode,
  urlToAppView,
} from "@commonfabric/shell/shared";
import "../cf-loader/cf-loader.ts";
import "../cf-cell-link/cf-cell-link.ts";

// Set to true to enable debug logging
const DEBUG_LOGGING = false;

/**
 * UI variants (CT-1321): the size/representation spectrum a piece can expose.
 * Each variant is an optional sibling key on the piece output, addressed by a
 * vended symbol; absent variants fail over to a per-variant platform default,
 * with the full [UI] as the universal floor. Patterns that export only [UI]
 * still render correctly at every variant.
 *
 * - `full`   — the main [UI] export; standalone rendering (default).
 * - `chip`   — inline-block in text/lists. Key: [CHIP_UI].
 *              Default: a `cf-cell-link` bound to the piece (renders by [NAME]).
 * - `tile`   — gallery/grid card. Key: [TILE_UI].
 *              Default: the full [UI] rendered small at ~0.5 scale.
 */
export type UIVariant = "full" | "chip" | "tile";

/**
 * Normalize the `variant` attribute to the size spectrum. Anything unrecognized
 * (undefined, legacy values) resolves to "full", the universal floor.
 */
export function normalizeVariant(variant: string | undefined): UIVariant {
  return variant === "chip" ? "chip" : variant === "tile" ? "tile" : "full";
}

/**
 * True when a piece output value carries a renderable variant at `key` (e.g.
 * `"$CHIP_UI"`). Used to decide whether to render the exported variant or fall
 * over to the platform default.
 */
export function hasVariantValue(value: unknown, key: string): boolean {
  return !!(value && typeof value === "object" &&
    (value as Record<string, unknown>)[key]);
}

/**
 * CFRender - Renders a cell that contains a piece pattern with UI
 *
 * @element cf-render
 *
 * @property {CellHandle} cell - The cell containing the piece to render
 * @property {UIVariant} variant - UI variant to render: "full" | "chip" | "tile"
 *   (default "full"). Renders the piece's matching variant key ([CHIP_UI] /
 *   [TILE_UI]) when exported, otherwise the per-variant platform default. The
 *   full [UI] is the universal floor, so every piece renders at every variant.
 *
 * @example
 * // Full standalone rendering (default)
 * <cf-render .cell=${myPieceCell}></cf-render>
 *
 * @example
 * // Chip: inline, renders [CHIP_UI] or a cf-cell-link default
 * <cf-render .cell=${myPieceCell} variant="chip"></cf-render>
 *
 * @example
 * // Tile: gallery card, renders [TILE_UI] or the full [UI] at ~0.5 scale
 * <cf-render .cell=${myPieceCell} variant="tile"></cf-render>
 */
export class CFRender extends BaseElement {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      overflow: hidden;
    }

    .render-container {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      overflow: auto;
    }

    /* Tile default: a fixed, clickable preview that navigates to the piece.
      The clip box pins the viewport (no panning/scrolling); the inner box is
      laid out at 2x then scaled to 0.5 so the full [UI] fills the tile. */
    .tile-clip {
      width: 100%;
      height: 100%;
      overflow: hidden;
      cursor: pointer;
    }

    .tile-default {
      width: 200%;
      height: 200%;
      transform: scale(0.5);
      transform-origin: top left;
      /* Clicks fall through to .tile-clip so the whole tile navigates,
        rather than activating controls inside the embedded UI. */
      pointer-events: none;
    }

    .loading-spinner {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      height: 100%;
      position: absolute;
      top: 0;
      left: 0;
    }

    :host {
      position: relative;
    }
  `;

  static override properties = {
    cell: { attribute: false },
    variant: { type: String },
  };

  declare cell: CellHandle;
  declare variant: UIVariant | undefined;

  // Use Lit ref directive for stable container reference across re-renders
  private _containerRef: Ref<HTMLDivElement> = createRef();

  private _cleanup?: () => void;
  // Track the cell ID we're currently rendering to detect stale renders
  private _renderingCellId?: string;

  @state()
  private accessor _hasRendered = false;
  private _startPromise?: Promise<boolean>;

  // Debug helpers
  private _instanceId = DEBUG_LOGGING
    ? Math.random().toString(36).substring(7)
    : "";
  private _log(...args: unknown[]) {
    if (DEBUG_LOGGING) {
      console.log(`[cf-render ${this._instanceId}]`, ...args);
    }
  }

  protected override render() {
    // Note: cf-cell-context is now auto-injected by the renderer when
    // traversing [UI] with a CellHandle, so we don't need to wrap here
    return html`
      ${!this._hasRendered
        ? html`
          <div class="loading-spinner">
            <cf-loader size="lg"></cf-loader>
          </div>
        `
        : null}
      <div class="render-container" ${ref(this._containerRef)}></div>
    `;
  }

  protected override updated(changedProperties: PropertyValues) {
    this._log(
      "updated called, changedProperties:",
      Array.from(changedProperties.keys()),
    );

    const cellChanged = changedProperties.has("cell");
    const variantChanged = changedProperties.has("variant");

    if (cellChanged || variantChanged) {
      let shouldRerender = false;

      if (cellChanged) {
        const oldCell = changedProperties.get("cell") as CellHandle | undefined;
        // Only re-render if the cell actually changed
        shouldRerender = !oldCell || !this.cell || !oldCell.equals(this.cell);
        this._log("cell property changed, should rerender:", shouldRerender);

        if (shouldRerender) {
          // Reset render state when cell changes - ensures we'll render the new cell
          this._hasRendered = false;
        }
      }

      if (variantChanged) {
        const oldVariant = changedProperties.get("variant") as
          | UIVariant
          | undefined;
        if (oldVariant !== this.variant) {
          shouldRerender = true;
          this._log("variant changed:", oldVariant, "->", this.variant);
        }
      }

      if (shouldRerender) {
        this._log("re-rendering due to cell or variant change");
        this._renderCell();
      }
    }
  }

  private async _renderCell() {
    const container = this._containerRef.value;
    const cellId = this.cell.id();
    this._renderingCellId = cellId;

    this._log(`_renderCell called: ${cellId}`);

    if (!container || !this.cell) {
      return;
    }

    this._cleanupRender();

    try {
      if (this._renderingCellId !== cellId) {
        this._log("cell changed during render, aborting");
        return;
      }

      // Normalize to the size spectrum; anything unknown renders full.
      const kind = normalizeVariant(this.variant);

      // Full is the universal floor: render the piece's [UI] chain directly.
      if (kind === "full") {
        this._log("rendering full [UI] into container");
        this._cleanup = render(container, this.cell as CellHandle<VNode>);
        this._hasRendered = true;
        return;
      }

      // chip/tile: the variant key may materialize asynchronously
      // (cross-space), so sync before probing for it.
      await this._startPromise;
      await this.cell.sync();
      if (this._renderingCellId !== cellId) return;

      const variantKey = kind === "chip" ? CHIP_UI : TILE_UI;
      if (this._cellHasKey(variantKey)) {
        this._log(`rendering exported ${variantKey}`);
        this._cleanup = render(
          container,
          (this.cell as CellHandle<Record<string, VNode>>)
            .key(variantKey) as CellHandle<VNode>,
        );
        this._hasRendered = true;
        return;
      }

      // Failover to the per-variant platform default.
      this._cleanup = kind === "chip"
        ? this._renderChipDefault(container)
        : this._renderTileDefault(container);
      this._hasRendered = true;
    } catch (error) {
      // Only show error if we're still rendering this cell
      if (this._renderingCellId === cellId) {
        this._handleRenderError(error);
      }
    }
  }

  /** True when the piece output exports a value at `key` (e.g. a variant UI). */
  private _cellHasKey(key: string): boolean {
    try {
      return hasVariantValue(this.cell.get(), key);
    } catch {
      return false;
    }
  }

  /** Chip default: a cf-cell-link bound to the piece (renders by [NAME]). */
  private _renderChipDefault(container: HTMLElement): () => void {
    const link = globalThis.document.createElement(
      "cf-cell-link",
    ) as HTMLElement & { cell?: CellHandle };
    link.cell = this.cell;
    container.appendChild(link);
    return () => link.remove();
  }

  /**
   * Tile default: the full [UI] rendered small at ~0.5 scale, clipped to a
   * fixed preview (no panning) and clickable to navigate to the piece —
   * mirroring cf-cell-link's navigation.
   */
  private _renderTileDefault(container: HTMLElement): () => void {
    const clip = globalThis.document.createElement("div");
    clip.className = "tile-clip";
    const scaler = globalThis.document.createElement("div");
    scaler.className = "tile-default";
    clip.appendChild(scaler);
    container.appendChild(clip);
    const inner = render(scaler, this.cell as CellHandle<VNode>);
    const onClick = (e: MouseEvent) => this._navigateToPiece(e);
    clip.addEventListener("click", onClick);
    return () => {
      clip.removeEventListener("click", onClick);
      inner?.();
      clip.remove();
    };
  }

  /** Navigate to the rendered piece (same behavior as cf-cell-link). */
  private _navigateToPiece(e: MouseEvent) {
    e.stopPropagation();
    try {
      const view = {
        spaceDid: this.cell.space(),
        pieceId: this.cell.id(),
      };
      // Cmd (Mac) / Ctrl (Win/Linux) opens in a new tab.
      if (e.metaKey || e.ctrlKey) {
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
    } catch (error) {
      console.error("[cf-render] tile navigation failed:", error);
    }
  }

  private _cleanupRender() {
    if (this._cleanup) {
      this._log("cleaning up previous render");
      this._cleanup();
      this._cleanup = undefined;
    }
  }

  private _handleRenderError(error: unknown) {
    console.error("[cf-render] Error rendering cell:", error);

    const container = this._containerRef.value;
    if (container) {
      container.innerHTML =
        `<div style="color: var(--cf-theme-color-error, var(--cf-colors-error, #ff6057))">Error rendering content: ${
          error instanceof Error ? error.message : "Unknown error"
        }</div>`;
    }
  }

  override disconnectedCallback() {
    this._log("disconnectedCallback called");
    super.disconnectedCallback();
    this._renderingCellId = undefined;
    this._hasRendered = false;
    this._cleanupRender();
  }
}

globalThis.customElements.define("cf-render", CFRender);
