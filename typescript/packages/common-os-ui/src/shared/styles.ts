import { css } from "lit";

export const base = css`
  @font-face {
    font-family: "Material Symbols Rounded";
    font-style: normal;
    src: url("./material-symbols.woff") format("woff");
  }

  .material-symbols-rounded {
    font-family: "Material Symbols Rounded";
    font-weight: normal;
    font-style: normal;
    font-size: 24px; /* Preferred icon size */
    display: inline-block;
    line-height: 1;
    text-transform: none;
    letter-spacing: normal;
    word-wrap: normal;
    white-space: nowrap;
    direction: ltr;
    font-variation-settings:
      "FILL" 1,
      "GRAD" 200;
  }

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
    --u-gap-sm: calc(var(--u) * 4);
    --bg: #fff;
    --bg-1: #fafafa;
    --bg-2: #f0f0f0;
    --bg-3: #d2d2d2;
    --bg-scrim: rgb(0 0 0 / 5%);
    --c-border: #d0d0d0;
    --c-text: #000;
    --c-text2: #969696;
    --c-placeholder: rgb(0, 0, 0 / 20%);
    --shadow-menu: 0px 2px 4px rgb(0, 0, 0 / 8%), 0px 0px 10px rgb(0, 0, 0 / 8%);
    --font-family: Helvetica, sans-serif;
    --dur-sm: 250ms;
    --dur-md: 500ms;
    --ease-out-cubic: cubic-bezier(0.215, 0.61, 0.355, 1);
    --ease-out-expo: cubic-bezier(0.19, 1, 0.22, 1);

    display: block;
  }

  * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
    font-weight: normal;
    color: var(--c-text);
    font-family: var(--font-family);
    font-size: var(--u-body-size);
    line-height: var(--u-body-line);
    list-style: none;
    -webkit-font-smoothing: antialiased;
    font-smooth: antialiased;
  }

  .defaults {
    display: block;
    color: var(--c-text);
    font-family: var(--font-family);
    font-size: var(--u-body-size);
    line-height: var(--u-body-line);
    -webkit-font-smoothing: antialiased;
    font-smooth: antialiased;
  }

  .body {
    font-family: var(--font-family);
    font-size: var(--u-body-size);
    line-height: var(--u-body-line);
    -webkit-font-smoothing: antialiased;
    font-smooth: antialiased;
  }

  .lg {
    font-family: var(--font-family);
    font-size: var(--u-lg-size);
    line-height: var(--u-lg-line);
    -webkit-font-smoothing: antialiased;
    font-smooth: antialiased;
  }

  .sm {
    font-family: var(--font-family);
    font-size: var(--u-sm-size);
    line-height: var(--u-sm-line);
    -webkit-font-smoothing: antialiased;
    font-smooth: antialiased;
  }

  .xsm {
    font-family: var(--font-family);
    font-size: var(--u-xsm-size);
    line-height: var(--u-xsm-line);
    -webkit-font-smoothing: antialiased;
    font-smooth: antialiased;
  }

  .title {
    font-weight: bold;
    font-family: var(--font-family);
    font-size: var(--u-body-size);
    line-height: var(--u-body-line);
    -webkit-font-smoothing: antialiased;
    font-smooth: antialiased;
  }

  .heading {
    font-weight: bold;
    font-family: var(--font-family);
    font-size: var(--u-heading-size);
    line-height: var(--u-heading-line);
    -webkit-font-smoothing: antialiased;
    font-smooth: antialiased;
  }

  .label {
    color: var(--c-text2);
    font-weight: normal;
    text-transform: uppercase;
    font-family: var(--font-family);
    font-size: var(--u-xsm-size);
    line-height: var(--u-xsm-line);
    -webkit-font-smoothing: antialiased;
    font-smooth: antialiased;
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
    align-items: center;
  }

  .gap {
    gap: var(--u-gap);
  }

  .gap-sm {
    gap: var(--u-gap-sm);
  }

  /*
  Fade out element by toggling ".fade.fade-out".
  Hidden element will have zero opacity and will not be interactable, but will
  still have the same box size in the DOM.
  */
  .fade {
    transition: opacity var(--dur-md) var(--ease-out-expo);

    &.fade-out {
      opacity: 0;
      pointer-events: none;
    }
  }
`;
