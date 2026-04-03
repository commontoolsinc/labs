/**
 * CF Chart Component Export and Registration
 */

import { CFChart } from "./cf-chart.ts";
import { MarkElement } from "./marks/base-mark.ts";
import { CFLineMark } from "./marks/cf-line-mark.ts";
import { CFAreaMark } from "./marks/cf-area-mark.ts";
import { CFBarMark } from "./marks/cf-bar-mark.ts";
import { CFDotMark } from "./marks/cf-dot-mark.ts";

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

if (!customElements.get("cf-chart")) {
  customElements.define("cf-chart", CFChart);
}
if (!customElements.get("cf-line-mark")) {
  customElements.define("cf-line-mark", CFLineMark);
}
if (!customElements.get("cf-area-mark")) {
  customElements.define("cf-area-mark", CFAreaMark);
}
if (!customElements.get("cf-bar-mark")) {
  customElements.define("cf-bar-mark", CFBarMark);
}
if (!customElements.get("cf-dot-mark")) {
  customElements.define("cf-dot-mark", CFDotMark);
}

export { CFAreaMark, CFBarMark, CFChart, CFDotMark, CFLineMark, MarkElement };

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
