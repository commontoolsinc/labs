export const LABELED_CELL_GRID_SHIFT = 2;
export const LABELED_CELL_GRID_MARGIN_TOP = 9;
export const DASHBOARD_GRID_RULE =
  `.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin-bottom:12px}`;
export const TILE_BOX_RULE =
  `.tile{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px;position:relative;isolation:isolate;overflow:hidden}`;
export const BOTTOM_CHART_RULES =
  `.tile.bottom-chart{display:flex;flex-direction:column}
  a.tile.link.bottom-chart{display:flex}
  .tile.bottom-chart .chart{margin-top:auto}`;
export const TILE_LABEL_RULE =
  `.lbl{font-size:11px;line-height:15px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted);margin:0 0 7px;display:flex;align-items:center;gap:7px;white-space:nowrap}`;

export function labeledCellGridRule(
  chartHeight: number,
  labelHeight: number,
): string {
  return `.cells.labeled{margin-top:${LABELED_CELL_GRID_MARGIN_TOP}px;height:${chartHeight}px;box-sizing:border-box;padding-bottom:${labelHeight}px;align-content:start;transform:translateY(-${LABELED_CELL_GRID_SHIFT}px)}`;
}

export function tileContentRules(
  chartHeight: number,
  labelHeight: number,
): string {
  return `${TILE_LABEL_RULE}
  .lbl .spacer{flex:1}
  .drill{min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:10px;color:var(--text-muted);letter-spacing:0;text-transform:none}
  .hmtd{min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:11px;color:var(--text-muted);letter-spacing:0;text-transform:none;font-variant-numeric:tabular-nums;margin-right:8px}
  .big{font-size:30px;font-weight:600;margin:0;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .sub{font-size:13px;color:var(--text-muted);margin:5px 0 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .running{display:inline-flex;align-items:center;gap:5px;font-size:10px;color:var(--text-muted);letter-spacing:.02em;text-transform:none;margin-top:10px}
  .lbl .running{margin-top:0;margin-right:8px}
  .rdot{width:7px;height:7px;border-radius:50%;background:var(--running);flex:none}
  .tile-detail-list{max-height:${
    chartHeight + 9
  }px;overflow-y:auto;overflow-x:hidden;scrollbar-gutter:stable}
  .tile-detail-list>div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cells{display:grid;gap:1px;margin-top:10px}
  ${labeledCellGridRule(chartHeight, labelHeight)}
  .cells.labeled .cell{aspect-ratio:auto;height:4px}
  .cell{aspect-ratio:1;border-radius:1px}
  .dot{width:10px;height:10px;display:inline-block;flex:none;position:relative}
  .dot::before{content:"";position:absolute;inset:0}
  .swatch{display:inline-block;width:8px;height:8px;border-radius:2px;vertical-align:middle}
  a.tile.link{display:block;text-decoration:none;color:inherit;cursor:pointer;transition:border-color .12s}`;
}
