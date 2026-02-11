/**
 * Shared types for ct-chart components
 */

/** Supported scale types for x-axis */
export type XScaleType = "linear" | "time" | "band";

/** Supported scale types for y-axis */
export type YScaleType = "linear" | "log";

/** Curve interpolation types */
export type CurveType = "linear" | "step" | "monotone" | "natural";

/** Mark types */
export type MarkType = "line" | "area" | "bar" | "dot";

/** A single mark configuration (for programmatic $marks prop) */
export interface MarkConfig {
  type: MarkType;
  data: number[] | Record<string, unknown>[];
  x?: string;
  y?: string;
  color?: string;
  label?: string;
  // Line/area specific
  strokeWidth?: number;
  curve?: CurveType;
  // Area specific
  opacity?: number;
  y2?: string | number;
  // Bar specific
  barPadding?: number;
  // Dot specific
  radius?: number;
}

/** Resolved data point after accessor extraction */
export interface DataPoint {
  x: unknown;
  y: number;
  datum: unknown;
  index: number;
}

/** Computed scale domains */
export interface Domains {
  x: [unknown, unknown] | unknown[];
  y: [number, number];
  xType: XScaleType;
}

/** Chart padding/margins */
export interface ChartPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Event detail for ct-hover */
export interface ChartHoverDetail {
  x: number;
  y: number;
  dataX: unknown;
  dataY: number;
  nearest: {
    datum: unknown;
    index: number;
    label?: string;
  } | null;
}

/** Event detail for ct-click */
export interface ChartClickDetail {
  x: number;
  y: number;
  dataX: unknown;
  dataY: number;
  nearest: {
    datum: unknown;
    index: number;
    label?: string;
  } | null;
}
