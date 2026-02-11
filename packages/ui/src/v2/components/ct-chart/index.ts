/**
 * CT Chart Component Export and Registration
 */

import { CTChart } from "./ct-chart.ts";
import { MarkElement } from "./marks/base-mark.ts";
import { CTLineMark } from "./marks/ct-line-mark.ts";
import { CTAreaMark } from "./marks/ct-area-mark.ts";
import { CTBarMark } from "./marks/ct-bar-mark.ts";
import { CTDotMark } from "./marks/ct-dot-mark.ts";

import type {
  AxisConfig,
  AxisOption,
  ChartClickDetail,
  ChartHoverDetail,
  ChartPadding,
  CurveType,
  MarkConfig,
  MarkType,
  XScaleType,
  YScaleType,
} from "./types.ts";

if (!customElements.get("ct-chart")) {
  customElements.define("ct-chart", CTChart);
}
if (!customElements.get("ct-line-mark")) {
  customElements.define("ct-line-mark", CTLineMark);
}
if (!customElements.get("ct-area-mark")) {
  customElements.define("ct-area-mark", CTAreaMark);
}
if (!customElements.get("ct-bar-mark")) {
  customElements.define("ct-bar-mark", CTBarMark);
}
if (!customElements.get("ct-dot-mark")) {
  customElements.define("ct-dot-mark", CTDotMark);
}

export { CTAreaMark, CTBarMark, CTChart, CTDotMark, CTLineMark, MarkElement };

export type {
  AxisConfig,
  AxisOption,
  ChartClickDetail,
  ChartHoverDetail,
  ChartPadding,
  CurveType,
  MarkConfig,
  MarkType,
  XScaleType,
  YScaleType,
};
