import { css } from "lit";

export const chartStyles = css`
  :host {
    display: block;
    box-sizing: border-box;
    width: 100%;
  }

  *,
  *::before,
  *::after {
    box-sizing: inherit;
  }

  .chart-container {
    position: relative;
    width: 100%;
    overflow: hidden;
  }

  svg {
    display: block;
    width: 100%;
  }

  .mark-group path,
  .mark-group rect,
  .mark-group circle {
    vector-effect: non-scaling-stroke;
  }

  .axis text {
    font-size: 10px;
    font-family: var(--ct-font-family, system-ui, sans-serif);
    fill: var(--ct-text-secondary, #888);
  }

  .axis line,
  .axis path {
    stroke: var(--ct-border-color, #ddd);
    stroke-width: 1;
    fill: none;
  }

  .crosshair line {
    stroke: var(--ct-text-secondary, #888);
    stroke-width: 1;
    stroke-dasharray: 4 2;
    pointer-events: none;
  }

  .tooltip {
    position: absolute;
    pointer-events: none;
    background: var(--ct-surface, #1a1a1a);
    color: var(--ct-text, #fff);
    border: 1px solid var(--ct-border-color, #333);
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 12px;
    font-family: var(--ct-font-family, system-ui, sans-serif);
    white-space: nowrap;
    z-index: 10;
    transform: translate(-50%, -100%);
    margin-top: -8px;
  }

  .tooltip-label {
    font-weight: 600;
    margin-right: 4px;
  }

  .interaction-overlay {
    fill: transparent;
    cursor: crosshair;
  }
`;
