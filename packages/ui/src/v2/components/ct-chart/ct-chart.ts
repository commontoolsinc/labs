/**
 * ct-chart - SVG charting container component.
 *
 * Discovers child mark elements via slotchange, collects their data,
 * computes scales, and renders all marks as SVG groups.
 *
 * @element ct-chart
 *
 * @attr {number} height - Chart height in px (default: 200). Width is responsive.
 * @attr {MarkConfig[]} marks - Programmatic marks (rendered below child marks)
 * @attr {boolean} xAxis - Show x-axis
 * @attr {boolean} yAxis - Show y-axis
 * @attr {string} xType - Scale type: "linear" | "time" | "band" (auto-detected)
 * @attr {string} yType - Scale type: "linear" | "log" (auto-detected)
 * @attr {[min, max]} xDomain - Override x domain
 * @attr {[min, max]} yDomain - Override y domain
 * @attr {boolean} crosshair - Show crosshair on hover (default: true)
 *
 * @fires ct-hover - Hover with nearest data point
 * @fires ct-click - Click with nearest data point
 * @fires ct-leave - Mouse leaves chart area
 */
import { html, svg, PropertyValues } from "lit";
import { type CellHandle } from "@commontools/runtime-client";
import { BaseElement } from "../../core/base-element.ts";
import { createCellController } from "../../core/cell-controller.ts";
import { chartStyles } from "./styles.ts";
import type {
  MarkConfig,
  XScaleType,
  YScaleType,
  ChartPadding,
} from "./types.ts";
import { MarkElement } from "./marks/base-mark.ts";
import {
  collectAllMarkData,
  createScales,
  type CollectedMarkData,
  type XScale,
  type YScale,
} from "./lib/scales.ts";
import { renderMark } from "./lib/render.ts";
import { renderXAxis, renderYAxis } from "./lib/axes.ts";
import {
  computeEventDetail,
  renderCrosshair,
  type NearestResult,
} from "./lib/interaction.ts";

// Import mark elements to ensure they're registered
import "./marks/ct-line-mark.ts";
import "./marks/ct-area-mark.ts";
import "./marks/ct-bar-mark.ts";
import "./marks/ct-dot-mark.ts";

const RESIZE_DEBOUNCE_MS = 100;
const DEFAULT_HEIGHT = 200;

export class CTChart extends BaseElement {
  static override styles = [BaseElement.baseStyles, chartStyles];

  static override properties = {
    height: { type: Number },
    marks: { attribute: false },
    xAxis: { type: Boolean },
    yAxis: { type: Boolean },
    xType: { type: String },
    yType: { type: String },
    xDomain: { attribute: false },
    yDomain: { attribute: false },
    padding: { attribute: false },
    crosshair: { type: Boolean },
  };

  declare height: number;
  declare marks: CellHandle<MarkConfig[]> | MarkConfig[];
  declare xAxis: boolean;
  declare yAxis: boolean;
  declare xType: XScaleType | undefined;
  declare yType: YScaleType | undefined;
  declare xDomain: [unknown, unknown] | undefined;
  declare yDomain: [number, number] | undefined;
  declare padding: number | [number, number, number, number] | undefined;
  declare crosshair: boolean;

  // Internal state
  private _width = 0;
  private _childMarks: MarkElement[] = [];
  private _resizeObserver: ResizeObserver | null = null;
  private _resizeTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private _crosshairX: number | null = null;
  private _tooltipInfo: NearestResult | null = null;

  // CellController for $marks prop
  private _marksController = createCellController<MarkConfig[]>(this, {
    timing: { strategy: "immediate" },
  });

  constructor() {
    super();
    this.height = DEFAULT_HEIGHT;
    this.xAxis = false;
    this.yAxis = false;
    this.crosshair = true;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener("mark-update", this._onMarkUpdate as EventListener);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener("mark-update", this._onMarkUpdate as EventListener);
    this._cleanup();
  }

  protected override firstUpdated(_changedProperties: PropertyValues): void {
    super.firstUpdated(_changedProperties);

    if (this.marks !== undefined) {
      this._marksController.bind(this.marks);
    }

    // Set up ResizeObserver
    const container = this.shadowRoot?.querySelector(".chart-container") as HTMLElement;
    if (container) {
      this._resizeObserver = new ResizeObserver((entries) => {
        if (this._resizeTimeoutId !== null) {
          clearTimeout(this._resizeTimeoutId);
        }
        this._resizeTimeoutId = setTimeout(() => {
          const entry = entries[0];
          if (entry) {
            this._width = entry.contentRect.width;
            this.requestUpdate();
          }
          this._resizeTimeoutId = null;
        }, RESIZE_DEBOUNCE_MS);
      });
      this._resizeObserver.observe(container);

      // Initial width measurement
      this._width = container.clientWidth;
    }

    // Discover initial slotted marks
    this._discoverChildMarks();
  }

  protected override updated(changedProperties: PropertyValues): void {
    super.updated(changedProperties);

    if (changedProperties.has("marks") && this.marks !== undefined) {
      this._marksController.bind(this.marks);
    }
  }

  override render() {
    const chartPadding = this._computePadding();
    const plotWidth = Math.max(0, this._width - chartPadding.left - chartPadding.right);
    const plotHeight = Math.max(0, this.height - chartPadding.top - chartPadding.bottom);

    // Collect mark data
    const configMarks = this._getConfigMarks();
    const allMarks = collectAllMarkData(configMarks, this._childMarks);

    // Compute scales (skip if no data or no width)
    let xScale: XScale | null = null;
    let yScale: YScale | null = null;
    let xType: XScaleType = "linear";

    if (allMarks.some((m) => m.points.length > 0) && plotWidth > 0 && plotHeight > 0) {
      const scales = createScales(allMarks, this._width, this.height, chartPadding, {
        xType: this.xType,
        yType: this.yType,
        xDomain: this.xDomain,
        yDomain: this.yDomain,
      });
      xScale = scales.xScale;
      yScale = scales.yScale;
      xType = scales.xType;
    }

    const svgContent = xScale && yScale
      ? this._renderChartContent(
        allMarks,
        xScale,
        yScale,
        xType,
        plotWidth,
        plotHeight,
        chartPadding,
        configMarks,
      )
      : svg``;

    const tooltip = this._tooltipInfo
      ? this._renderTooltip(chartPadding)
      : html``;

    const w = this._width || "100%";
    const vw = this._width || 1;

    return html`
      <div class="chart-container" style="height: ${this.height}px;">
        <svg width="${w}" height="${this.height}" viewBox="0 0 ${vw} ${this.height}">
          ${svgContent}
        </svg>
        ${tooltip}
        <slot @slotchange=${this._onSlotChange}></slot>
      </div>
    `;
  }

  // === Chart content rendering ===

  private _renderChartContent(
    allMarks: CollectedMarkData[],
    xScale: XScale,
    yScale: YScale,
    xType: XScaleType,
    plotWidth: number,
    plotHeight: number,
    chartPadding: ChartPadding,
    configMarks: readonly MarkConfig[],
  ) {
    const marks = this._renderAllMarks(
      allMarks, xScale, yScale, plotWidth, plotHeight, configMarks,
    );
    const xAxisSvg = this.xAxis
      ? renderXAxis(xScale, xType, plotWidth, plotHeight)
      : svg``;
    const yAxisSvg = this.yAxis
      ? renderYAxis(yScale, plotHeight)
      : svg``;
    const crosshairSvg = this.crosshair && this._crosshairX !== null
      ? renderCrosshair(this._crosshairX, plotHeight)
      : svg``;

    const onMove = (e: MouseEvent) =>
      this._handleMouseMove(e, allMarks, xScale, yScale, xType, chartPadding);
    const onClick = (e: MouseEvent) =>
      this._handleClick(e, allMarks, xScale, yScale, xType, chartPadding);
    const tx = chartPadding.left;
    const ty = chartPadding.top;

    return svg`<g transform="translate(${tx}, ${ty})">${marks}${xAxisSvg}${yAxisSvg}${crosshairSvg}<rect class="interaction-overlay" width="${plotWidth}" height="${plotHeight}" @mousemove=${onMove} @click=${onClick} @mouseleave=${this._handleMouseLeave} /></g>`;
  }

  // === Mark rendering ===

  private _renderAllMarks(
    allMarks: CollectedMarkData[],
    xScale: XScale,
    yScale: YScale,
    _plotWidth: number,
    plotHeight: number,
    configMarks: readonly MarkConfig[],
  ) {
    const configCount = configMarks.length;

    const groups = allMarks.map((markData, i) => {
      const config = i < configCount
        ? configMarks[i]
        : this._childMarks[i - configCount];

      const rendered = renderMark(
        markData.type,
        markData.points,
        xScale,
        yScale,
        plotHeight,
        config as MarkConfig | MarkElement,
      );

      return svg`<g class="mark-group" data-mark-index="${i}">${rendered}</g>`;
    });

    return svg`${groups}`;
  }

  // === Tooltip rendering ===

  private _renderTooltip(padding: ChartPadding) {
    if (!this._tooltipInfo) return html``;

    const { pixelX, pixelY, point, label } = this._tooltipInfo;
    const x = pixelX + padding.left;
    const y = pixelY + padding.top;

    const yVal = typeof point.y === "number"
      ? (Number.isInteger(point.y) ? point.y : point.y.toFixed(2))
      : point.y;

    return html`
      <div class="tooltip" style="left: ${x}px; top: ${y}px;">
        ${label ? html`<span class="tooltip-label">${label}:</span>` : html``}
        <span>${yVal}</span>
      </div>
    `;
  }

  // === Event handlers ===

  private _handleMouseMove(
    e: MouseEvent,
    allMarks: CollectedMarkData[],
    xScale: XScale,
    yScale: YScale,
    xType: XScaleType,
    padding: ChartPadding,
  ): void {
    const rect = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const offsetX = e.clientX - rect.left + padding.left;
    const offsetY = e.clientY - rect.top + padding.top;

    const { detail, nearest } = computeEventDetail(
      offsetX, offsetY, allMarks, xScale, yScale, xType, padding,
    );

    if (this.crosshair && nearest) {
      this._crosshairX = nearest.pixelX;
      this._tooltipInfo = nearest;
      this.requestUpdate();
    }

    this.emit("ct-hover", detail);
  }

  private _handleClick(
    e: MouseEvent,
    allMarks: CollectedMarkData[],
    xScale: XScale,
    yScale: YScale,
    xType: XScaleType,
    padding: ChartPadding,
  ): void {
    const rect = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const offsetX = e.clientX - rect.left + padding.left;
    const offsetY = e.clientY - rect.top + padding.top;

    const { detail } = computeEventDetail(
      offsetX, offsetY, allMarks, xScale, yScale, xType, padding,
    );

    this.emit("ct-click", detail);
  }

  private _handleMouseLeave = (): void => {
    this._crosshairX = null;
    this._tooltipInfo = null;
    this.requestUpdate();
    this.emit("ct-leave", {});
  };

  // === Slot management ===

  private _onSlotChange = (): void => {
    this._discoverChildMarks();
    this.requestUpdate();
  };

  private _onMarkUpdate = (): void => {
    this.requestUpdate();
  };

  private _discoverChildMarks(): void {
    const slot = this.shadowRoot?.querySelector("slot");
    if (!slot) {
      this._childMarks = [];
      return;
    }

    const nodes = slot.assignedElements({ flatten: true });
    this._childMarks = nodes.filter(
      (n): n is MarkElement => n instanceof MarkElement,
    );
  }

  // === Config marks ===

  private _getConfigMarks(): readonly MarkConfig[] {
    return this._marksController.getValue() || [];
  }

  // === Padding computation ===

  private _computePadding(): ChartPadding {
    if (this.padding !== undefined) {
      if (typeof this.padding === "number") {
        return {
          top: this.padding,
          right: this.padding,
          bottom: this.padding,
          left: this.padding,
        };
      }
      const [t, r, b, l] = this.padding;
      return { top: t, right: r, bottom: b, left: l };
    }

    // Auto-calculate based on axes
    return {
      top: 8,
      right: 8,
      bottom: this.xAxis ? 28 : 8,
      left: this.yAxis ? 48 : 8,
    };
  }

  // === Cleanup ===

  private _cleanup(): void {
    if (this._resizeTimeoutId !== null) {
      clearTimeout(this._resizeTimeoutId);
      this._resizeTimeoutId = null;
    }
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
  }
}

customElements.define("ct-chart", CTChart);

declare global {
  interface HTMLElementTagNameMap {
    "ct-chart": CTChart;
  }
}
