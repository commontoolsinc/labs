import { css } from "lit";

export const base = css`
  :host {
    /*
    Baseline grid unit.
    - Components should line up to 8px baseline grid (2x multiples)
    - Text and icons should line up to 4px baseline grid (1x multiples)
    */
    --u: 4px;
    --u-min-touch-size: calc(var(--u) * 11);
    --u-radius: calc(var(--u) * 3);
    --u-radius2: calc(var(--u) * 6);
    /* Body size 17px */
    --u-body-size: calc(var(--u) * 4.25);
    --u-body-line: calc(var(--u) * 6);
    /* Heading size 24px */
    --u-heading-size: calc(var(--u) * 6);
    --u-heading-line: calc(var(--u) * 7);
    /* Large text size 24px with more generous line height */
    --u-lg-size: calc(var(--u) * 6);
    --u-lg-line: calc(var(--u) * 8);
    /* sm size 13px */
    --u-sm-size: calc(var(--u) * 3.25);
    --u-sm-line: calc(var(--u) * 5);
    /* xsm size 11px */
    --u-xsm-size: calc(var(--u) * 2.75);
    --u-xsm-line: calc(var(--u) * 4);
    --u-pad: calc(var(--u) * 6);
    --u-gap: calc(var(--u) * 6);
    --bg: #fff;
    --bg-1: #fafafa;
    --bg-2: #f0f0f0;
    --bg-3: #d2d2d2;
    --bg-scrim: rgba(0 0 0 / 5%);
    --c-border: #d0d0d0;
    --c-text: #000;
    --c-text2: #969696;
    --c-placeholder: --shadow-menu: 0px 2px 4px rgba(0, 0, 0, 0.08),
      0px 0px 10px rgba(0, 0, 0, 0.08);
    --font-family: Helvetica, sans-serif;

    display: block;
    color: var(--c-text);
    font-family: var(--font-family);
    font-size: var(--u-body-size);
    line-height: var(--u-body-line);
  }

  * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
    font-size: inherit;
    list-style: none;
  }

  .body {
    font-family: var(--font-family);
    font-size: var(--u-body-size);
    line-height: var(--u-body-line);
  }

  .lg {
    font-family: var(--font-family);
    font-size: var(--u-lg-size);
    line-height: var(--u-lg-line);
  }

  .sm {
    font-family: var(--font-family);
    font-size: var(--u-sm-size);
    line-height: var(--u-sm-line);
  }

  .xsm {
    font-family: var(--font-family);
    font-size: var(--u-xsm-size);
    line-height: var(--u-xsm-line);
  }

  .title {
    font-weight: bold;
    font-family: var(--font-family);
    font-size: var(--u-body-size);
    line-height: var(--u-body-line);
  }

  .heading {
    font-weight: bold;
    font-family: var(--font-family);
    font-size: var(--u-heading-size);
    line-height: var(--u-heading-line);
  }

  .label {
    color: var(--c-text2);
    font-weight: normal;
    font-family: var(--font-family);
    font-size: var(--u-xsm-size);
    line-height: var(--u-xsm-line);
  }

  .c-text {
    color: var(--c-text);
  }

  .c-text2 {
    color: var(--c-text2);
  }

  .vstack {
    display: flex;
    flex-direction: column;
  }

  .hstack {
    display: flex;
    flex-direction: row;
  }

  .gap {
    gap: var(--u-gap);
  }
`;
